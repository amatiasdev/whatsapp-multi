const whatsappService = require('../services/whatsappService');
const qrService = require('../services/qrService');
const logger = require('../utils/logger');

class SessionController {
  async initializeSession(req, res) {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const result = await whatsappService.initializeClient(sessionId);
      logger.info(`Inicialización de sesión: ${sessionId}`, { result });
      
      return res.status(200).json({ 
        success: true, 
        ...result
      });
    } catch (error) {
      logger.error('Error al inicializar sesión:', {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.body?.sessionId
      });
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async startListening(req, res) {
    try {
      const { sessionId = 'default' } = req.body;
      
      logger.debug(`Iniciando escucha para sesión: ${sessionId}`);
      
      // Verificar si la sesión ya existe
      const sessionExists = await whatsappService.checkSessionExists(sessionId);
      
      // Si la sesión existe y ya está conectada, solo iniciamos escucha
      if (sessionExists) {
        const status = await whatsappService.getSessionStatus(sessionId);
        
        if (status.isConnected) {
          // La sesión ya existe y está conectada, podemos iniciar escucha directamente
          const listenResult = await whatsappService.startListening(sessionId);
          return res.status(200).json({
            success: true,
            sessionId,
            status: 'connected',
            listening: listenResult
          });
        }
      }
      
      // Si llegamos aquí, necesitamos inicializar o reconectar
      const result = await whatsappService.initializeAndListen(sessionId);
      
      // Respuesta más precisa sobre el estado real
      res.status(200).json({
        success: true,
        sessionId,
        status: 'initializing',
        message: sessionExists 
          ? "Reconectando sesión existente, escanee el código QR" 
          : "Iniciando nueva sesión, escanee el código QR",
        initialization: result.initialization
      });
      
    } catch (error) {
      logger.error(`Error al iniciar sesión:`, {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.body?.sessionId
      });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async stopListening(req, res) {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const result = whatsappService.stopListening(sessionId);
      logger.info(`Detención de escucha para sesión: ${sessionId}`, { result });
      
      return res.status(200).json({ 
        success: true, 
        ...result
      });
    } catch (error) {
      logger.error('Error al detener escucha:', {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.body?.sessionId
      });
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getSessionStatus(req, res) {
    try {
      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const status = await whatsappService.getSessionStatus(sessionId);
      return res.status(200).json({ 
        success: true, 
        status
      });
    } catch (error) {
      logger.error('Error al obtener estado de sesión:', {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.params?.sessionId
      });
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getAllSessions(req, res) {
    try {
      const sessions = await whatsappService.getAllSessions();
      return res.status(200).json({ 
        success: true, 
        sessions
      });
    } catch (error) {
      logger.error('Error al obtener todas las sesiones:', {
        errorMessage: error.message,
        stack: error.stack
      });
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async cleanupSession(req, res) {
    try {
      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      await whatsappService.cleanupSession(sessionId);
      return res.status(200).json({ 
        success: true, 
        message: `Sesión ${sessionId} eliminada correctamente`
      });
    } catch (error) {
      logger.error('Error al eliminar sesión:', {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.params?.sessionId
      });
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async checkConnectionStatus(req, res) {
    try {
      const { sessionId = 'default' } = req.params;
      
      logger.debug(`Verificando estado de conexión para sesión: ${sessionId}`);
      
      const status = await whatsappService.getSessionStatus(sessionId);
      
      // Determinar estado detallado
      let connectionStatus = 'disconnected';
      
      if (status.exists) {
        if (status.isConnected) {
          connectionStatus = 'connected';
          if (status.isListening) {
            connectionStatus = 'listening';
          }
        } else {
          connectionStatus = 'initializing';
          
          // Comprobar si hay un QR disponible
          try {
            const qrData = await qrService.getQR(sessionId);
            if (qrData && qrData.qr) {
              connectionStatus = 'waiting_for_scan';
            }
          } catch (qrError) {
            logger.debug(`No se pudo obtener QR para sesión ${sessionId}:`, {
              errorMessage: qrError.message
            });
          }
        }
      }
      
      res.status(200).json({
        success: true,
        sessionId,
        connectionStatus,
        details: status
      });
      
    } catch (error) {
      logger.error(`Error al obtener estado de conexión:`, {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.params?.sessionId
      });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

    /**
   * Reconecta una sesión existente sin crear una nueva instancia
   */
  async reconnectSession(req, res) {
    try {
      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Se requiere sessionId' 
        });
      }
      
      logger.info(`Iniciando reconexión para sesión ${sessionId}`);
      
      // Verificar que la sesión existe
      const sessionExists = await whatsappService.checkSessionExists(sessionId);
      if (!sessionExists) {
        return res.status(404).json({
          success: false,
          error: `Sesión ${sessionId} no encontrada`
        });
      }
      
      // Obtener estado actual de la sesión
      const currentStatus = await whatsappService.getSessionStatus(sessionId);
      
      // Si ya está conectada, no hacer nada
      if (currentStatus.isConnected) {
        return res.status(200).json({
          success: true,
          sessionId,
          status: 'already_connected',
          message: 'La sesión ya está conectada',
          details: currentStatus
        });
      }
      
      // Intentar reconexión
      const reconnectResult = await whatsappService.reconnectSession(sessionId);
      
      logger.info(`Reconexión iniciada para sesión ${sessionId}`, { reconnectResult });
      
      return res.status(200).json({
        success: true,
        sessionId,
        status: 'reconnecting',
        message: 'Proceso de reconexión iniciado. Escanee el código QR si aparece.',
        ...reconnectResult
      });
      
    } catch (error) {
      logger.error('Error al reconectar sesión:', {
        errorMessage: error.message,
        stack: error.stack,
        sessionId: req.params?.sessionId
      });
      
      return res.status(500).json({
        success: false,
        error: error.message,
        sessionId: req.params?.sessionId
      });
    }
  }

  /**
   * Limpia sesiones expiradas y optimiza recursos
   */
  async cleanupExpiredSessions(req, res) {
    try {
      const { force = false } = req.query;
      
      logger.info('Iniciando limpieza de sesiones expiradas', { force });
      
      const cleanupResult = await whatsappService.cleanupExpiredSessions(force);
      
      return res.status(200).json({
        success: true,
        message: 'Limpieza de sesiones completada',
        ...cleanupResult
      });
      
    } catch (error) {
      logger.error('Error al limpiar sesiones expiradas:', {
        errorMessage: error.message,
        stack: error.stack
      });
      
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Obtiene estadísticas detalladas de las sesiones
   */
  async getSessionsStats(req, res) {
    try {
      const stats = await whatsappService.getSessionsStatistics();
      
      return res.status(200).json({
        success: true,
        stats,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Error al obtener estadísticas de sesiones:', {
        errorMessage: error.message,
        stack: error.stack
      });
      
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = new SessionController();