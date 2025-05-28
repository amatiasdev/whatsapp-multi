// src/services/sessionLifecycleManager.js - Nuevo servicio para gestión avanzada de sesiones

const logger = require('../utils/logger');
const config = require('../config');

class SessionLifecycleManager {
  constructor(whatsappService) {
    this.whatsappService = whatsappService;
    this.cleanupInterval = null;
    this.sessionLimits = new Map(); // sessionId -> { createdAt, userId, etc }
    this.userSessions = new Map(); // userId -> Set(sessionIds)
    
    // Iniciar limpieza automática cada 2 horas
    this.startAutomaticCleanup();
  }

  /**
   * Inicia el proceso de limpieza automática
   */
  startAutomaticCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Ejecutar limpieza cada 2 horas
    this.cleanupInterval = setInterval(async () => {
      try {
        logger.info('Ejecutando limpieza automática de sesiones');
        await this.whatsappService.cleanupExpiredSessions(false);
      } catch (error) {
        logger.error('Error en limpieza automática:', {
          errorMessage: error.message
        });
      }
    }, 2 * 60 * 60 * 1000); // 2 horas
    
    logger.info('Limpieza automática de sesiones programada cada 2 horas');
  }

  /**
   * Detiene la limpieza automática
   */
  stopAutomaticCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('Limpieza automática de sesiones detenida');
    }
  }

  /**
   * Valida si un usuario puede crear una nueva sesión
   * @param {string} userId - ID del usuario (opcional, usar sessionId si no hay autenticación)
   * @param {string} sessionId - ID de la sesión a crear
   * @returns {Object} - Resultado de la validación
   */
  async validateSessionCreation(userId = null, sessionId) {
    const maxSessionsPerUser = 3;
    const userKey = userId || 'default-user';
    
    // Obtener sesiones activas del usuario
    const userSessions = this.userSessions.get(userKey) || new Set();
    const activeSessions = [];
    
    // Verificar cuáles sesiones siguen activas
    for (const sessionId of userSessions) {
      try {
        const status = await this.whatsappService.getSessionStatus(sessionId);
        if (status.exists) {
          activeSessions.push({
            sessionId,
            isConnected: status.isConnected,
            isListening: status.isListening
          });
        } else {
          // Sesión no existe, remover del tracking
          userSessions.delete(sessionId);
        }
      } catch (error) {
        // En caso de error, asumir que la sesión no existe
        userSessions.delete(sessionId);
      }
    }
    
    // Actualizar el mapa de usuarios
    if (userSessions.size === 0) {
      this.userSessions.delete(userKey);
    } else {
      this.userSessions.set(userKey, userSessions);
    }
    
    // Validar límites
    if (activeSessions.length >= maxSessionsPerUser) {
      return {
        allowed: false,
        reason: 'session_limit_reached',
        maxSessions: maxSessionsPerUser,
        currentSessions: activeSessions.length,
        activeSessions: activeSessions
      };
    }
    
    // Verificar límite global del sistema
    const allSessions = await this.whatsappService.getAllSessions();
    if (allSessions.length >= config.maxSessions) {
      return {
        allowed: false,
        reason: 'system_limit_reached',
        maxSystemSessions: config.maxSessions,
        currentSystemSessions: allSessions.length
      };
    }
    
    return {
      allowed: true,
      currentUserSessions: activeSessions.length,
      maxUserSessions: maxSessionsPerUser,
      currentSystemSessions: allSessions.length,
      maxSystemSessions: config.maxSessions
    };
  }

  /**
   * Registra una nueva sesión en el tracking
   * @param {string} sessionId - ID de la sesión
   * @param {string} userId - ID del usuario (opcional)
   */
  registerSession(sessionId, userId = null) {
    const userKey = userId || 'default-user';
    
    // Agregar al tracking por usuario
    if (!this.userSessions.has(userKey)) {
      this.userSessions.set(userKey, new Set());
    }
    this.userSessions.get(userKey).add(sessionId);
    
    // Registrar información de la sesión
    this.sessionLimits.set(sessionId, {
      userId: userKey,
      createdAt: Date.now(),
      lastActivity: Date.now()
    });
    
    logger.info(`Sesión ${sessionId} registrada para usuario ${userKey}`);
  }

  /**
   * Desregistra una sesión del tracking
   * @param {string} sessionId - ID de la sesión
   */
  unregisterSession(sessionId) {
    const sessionInfo = this.sessionLimits.get(sessionId);
    if (sessionInfo) {
      const userKey = sessionInfo.userId;
      
      // Remover del tracking por usuario
      if (this.userSessions.has(userKey)) {
        this.userSessions.get(userKey).delete(sessionId);
        
        // Si no quedan sesiones, remover usuario
        if (this.userSessions.get(userKey).size === 0) {
          this.userSessions.delete(userKey);
        }
      }
      
      // Remover información de sesión
      this.sessionLimits.delete(sessionId);
      
      logger.info(`Sesión ${sessionId} desregistrada`);
    }
  }

  /**
   * Actualiza la actividad de una sesión
   * @param {string} sessionId - ID de la sesión
   */
  updateSessionActivity(sessionId) {
    const sessionInfo = this.sessionLimits.get(sessionId);
    if (sessionInfo) {
      sessionInfo.lastActivity = Date.now();
    }
  }

  /**
   * Obtiene estadísticas de uso por usuario
   * @returns {Object} - Estadísticas detalladas
   */
  getUserUsageStats() {
    const stats = {
      totalUsers: this.userSessions.size,
      totalSessions: 0,
      userBreakdown: [],
      averageSessionsPerUser: 0
    };

    for (const [userId, sessions] of this.userSessions.entries()) {
      const userStats = {
        userId,
        sessionCount: sessions.size,
        sessions: Array.from(sessions).map(sessionId => {
          const info = this.sessionLimits.get(sessionId);
          return {
            sessionId,
            createdAt: info ? new Date(info.createdAt) : null,
            lastActivity: info ? new Date(info.lastActivity) : null
          };
        })
      };

      stats.userBreakdown.push(userStats);
      stats.totalSessions += sessions.size;
    }

    stats.averageSessionsPerUser = stats.totalUsers > 0 ? 
      Math.round((stats.totalSessions / stats.totalUsers) * 100) / 100 : 0;

    // Ordenar por número de sesiones (descendente)
    stats.userBreakdown.sort((a, b) => b.sessionCount - a.sessionCount);

    return stats;
  }

  /**
   * Identifica sesiones problemáticas que necesitan atención
   * @returns {Array} - Lista de sesiones problemáticas
   */
  async identifyProblematicSessions() {
    const now = Date.now();
    const problematicSessions = [];
    const twoHoursAgo = now - (2 * 60 * 60 * 1000);
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    try {
      const allSessions = await this.whatsappService.getAllSessions();
      
      for (const session of allSessions) {
        const sessionInfo = this.sessionLimits.get(session.sessionId);
        const issues = [];
        
        // Verificar actividad reciente
        const lastActivity = sessionInfo ? sessionInfo.lastActivity : 0;
        if (lastActivity < twoHoursAgo) {
          issues.push('inactive_2h');
        }
        if (lastActivity < oneDayAgo) {
          issues.push('inactive_24h');
        }
        
        // Verificar estado de conexión
        if (!session.isConnected) {
          issues.push('disconnected');
        }
        
        // Verificar buffer acumulado
        if (session.bufferSize && session.bufferSize > 50) {
          issues.push('large_buffer');
        }
        
        // Verificar intentos de reconexión
        try {
          const detailedInfo = await this.whatsappService.getSessionInfo(session.sessionId);
          if (detailedInfo.reconnectionAttempts && detailedInfo.reconnectionAttempts > 3) {
            issues.push('multiple_reconnection_attempts');
          }
        } catch (error) {
          issues.push('status_check_failed');
        }
        
        if (issues.length > 0) {
          problematicSessions.push({
            sessionId: session.sessionId,
            issues,
            lastActivity: new Date(lastActivity),
            currentStatus: session,
            severity: this.calculateSeverity(issues)
          });
        }
      }
      
      // Ordenar por severidad (más severo primero)
      problematicSessions.sort((a, b) => b.severity - a.severity);
      
    } catch (error) {
      logger.error('Error al identificar sesiones problemáticas:', {
        errorMessage: error.message
      });
    }

    return problematicSessions;
  }

  /**
   * Calcula la severidad de los problemas de una sesión
   * @param {Array} issues - Lista de problemas
   * @returns {number} - Nivel de severidad (mayor = más severo)
   */
  calculateSeverity(issues) {
    const severityMap = {
      'inactive_24h': 10,
      'multiple_reconnection_attempts': 8,
      'status_check_failed': 7,
      'disconnected': 5,
      'large_buffer': 4,
      'inactive_2h': 2
    };

    return issues.reduce((total, issue) => {
      return total + (severityMap[issue] || 1);
    }, 0);
  }

  /**
   * Destructor - limpia recursos
   */
  destroy() {
    this.stopAutomaticCleanup();
    this.sessionLimits.clear();
    this.userSessions.clear();
    logger.info('SessionLifecycleManager destruido');
  }
}

module.exports = SessionLifecycleManager;