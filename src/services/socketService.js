/**
 * src/services/socketService.js
 * Servicio para gestionar la comunicación en tiempo real con sockets
 */

const socketIO = require('socket.io');
const logger = require('../utils/logger');

class SocketService {
  constructor() {
    this.io = null;
    this.connections = new Map(); // Map de sessionId -> Set de socket.id
    this.pollingIntervals = new Map(); // Map de sessionId -> intervalo de polling
  }

  /**
   * Inicializa el servicio de Socket.IO
   * @param {Object} server - Servidor HTTP de Express
   */
  initialize(server) {
    try {
      this.io = socketIO(server, {
        cors: {
          origin: "*", // En producción, limitar a dominios específicos
          methods: ["GET", "POST"]
        },
        // Agregar configuraciones adicionales para estabilidad
        pingTimeout: 60000,
        pingInterval: 25000,
        connectTimeout: 45000,
        maxHttpBufferSize: 1e6 // 1MB
      });

      this.io.on('connection', (socket) => {
        logger.info(`Socket conectado: ${socket.id}`);

        // Manejar suscripción a una sesión
        socket.on('subscribe', (sessionId) => {
          try {
            if (!sessionId) {
              logger.warn(`Socket ${socket.id} intentó suscribirse sin sessionId`);
              return;
            }

            // Crear set de sockets si no existe para esta sesión
            if (!this.connections.has(sessionId)) {
              this.connections.set(sessionId, new Set());
            }
            
            // Añadir este socket a la sesión
            this.connections.get(sessionId).add(socket.id);
            
            // Unir al socket a una sala con el ID de la sesión
            socket.join(sessionId);
            
            logger.info(`Socket ${socket.id} suscrito a la sesión ${sessionId}`);
            
            // Confirmar suscripción al cliente
            socket.emit('subscribed', { sessionId, socketId: socket.id });
          } catch (error) {
            logger.error(`Error al suscribir socket ${socket.id} a sesión ${sessionId}:`, {
              errorMessage: error.message,
              socketId: socket.id,
              sessionId
            });
          }
        });

        // Manejar cancelación de suscripción
        socket.on('unsubscribe', (sessionId) => {
          try {
            if (!sessionId) {
              logger.warn(`Socket ${socket.id} intentó desuscribirse sin sessionId`);
              return;
            }

            if (this.connections.has(sessionId)) {
              // Eliminar este socket de la sesión
              this.connections.get(sessionId).delete(socket.id);
              
              // Si no quedan sockets, eliminar la sesión
              if (this.connections.get(sessionId).size === 0) {
                this.connections.delete(sessionId);
              }
            }
            
            // Sacar al socket de la sala
            socket.leave(sessionId);
            
            logger.info(`Socket ${socket.id} desuscrito de la sesión ${sessionId}`);
            
            // Confirmar desuscripción al cliente
            socket.emit('unsubscribed', { sessionId, socketId: socket.id });
          } catch (error) {
            logger.error(`Error al desuscribir socket ${socket.id} de sesión ${sessionId}:`, {
              errorMessage: error.message,
              socketId: socket.id,
              sessionId
            });
          }
        });

        // Manejar errores del socket
        socket.on('error', (error) => {
          logger.error(`Error en socket ${socket.id}:`, {
            errorMessage: error.message,
            socketId: socket.id
          });
        });

        // Manejar desconexión
        socket.on('disconnect', (reason) => {
          logger.info(`Socket desconectado: ${socket.id}, razón: ${reason}`);
          
          try {
            // Eliminar este socket de todas las sesiones
            for (const [sessionId, sockets] of this.connections.entries()) {
              if (sockets.has(socket.id)) {
                sockets.delete(socket.id);
                
                // Si no quedan sockets, eliminar la sesión
                if (sockets.size === 0) {
                  this.connections.delete(sessionId);
                  logger.debug(`Sesión ${sessionId} eliminada (no quedan sockets conectados)`);
                }
                
                logger.debug(`Socket ${socket.id} eliminado de la sesión ${sessionId}`);
              }
            }
          } catch (error) {
            logger.error(`Error al limpiar socket desconectado ${socket.id}:`, {
              errorMessage: error.message,
              socketId: socket.id
            });
          }
        });
      });

      // Manejar errores del servidor Socket.IO
      this.io.on('error', (error) => {
        logger.error('Error en servidor Socket.IO:', {
          errorMessage: error.message,
          stack: error.stack
        });
      });

      logger.info('Servicio de Socket.IO inicializado');
      return this.io;
    } catch (error) {
      logger.error('Error al inicializar Socket.IO:', {
        errorMessage: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Verifica si el servicio está inicializado
   */
  isInitialized() {
    return this.io !== null;
  }

  /**
   * Envía un código QR a todos los clientes suscritos a una sesión
   * @param {string} sessionId - ID de la sesión
   * @param {string} qr - Código QR
   */
  emitQRCode(sessionId, qr) {
    if (!this.isInitialized()) {
      logger.warn('Intento de emitir QR antes de inicializar Socket.IO');
      return;
    }

    if (!sessionId || !qr) {
      logger.warn('SessionId o QR vacío al intentar emitir');
      return;
    }
    
    this.io.to(sessionId).emit('qr', {
      sessionId,
      qr,
      timestamp: Date.now()
    });
    
    logger.debug(`QR emitido para sesión ${sessionId}`);
  }

  /**
   * Emite un código QR para una sesión específica y actualiza su estado
   * @param {string} sessionId - ID de la sesión
   * @param {string} qrCode - Código QR a emitir
   * @param {number} expiresAt - Timestamp de expiración (opcional)
   */
  emitQRForSession(sessionId, qrCode, expiresAt = null) {
    try {
      if (!expiresAt) {
        expiresAt = Date.now() + 60000; // 60 segundos por defecto
      }
      
      this.emitQRCode(sessionId, qrCode);
      this.emitSessionStatus(sessionId, 'qr_ready', {
        expiresAt: expiresAt
      });
      
      logger.info(`QR emitido y estado actualizado para sesión ${sessionId}`);
    } catch (error) {
      logger.error(`Error al emitir QR para sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId
      });
    }
  }

  /**
   * Marca una sesión como conectada
   * @param {string} sessionId - ID de la sesión
   */
  markSessionConnected(sessionId) {
    try {
      this.emitSessionStatus(sessionId, 'connected', {
        connectedAt: Date.now()
      });
      
      logger.info(`Sesión ${sessionId} marcada como conectada vía socket`);
    } catch (error) {
      logger.error(`Error al marcar sesión como conectada ${sessionId}:`, {
        errorMessage: error.message,
        sessionId
      });
    }
  }

  /**
   * Marca una sesión como desconectada
   * @param {string} sessionId - ID de la sesión
   */
  markSessionDisconnected(sessionId) {
    try {
      this.emitSessionStatus(sessionId, 'disconnected', {
        disconnectedAt: Date.now()
      });
      
      logger.info(`Sesión ${sessionId} marcada como desconectada vía socket`);
    } catch (error) {
      logger.error(`Error al marcar sesión como desconectada ${sessionId}:`, {
        errorMessage: error.message,
        sessionId
      });
    }
  }

  /**
   * Marca un código QR como expirado
   * @param {string} sessionId - ID de la sesión
   */
  markQRExpired(sessionId) {
    try {
      this.emitSessionStatus(sessionId, 'qr_expired', {
        expiredAt: Date.now()
      });
      
      logger.info(`QR de sesión ${sessionId} marcado como expirado vía socket`);
    } catch (error) {
      logger.error(`Error al marcar QR como expirado ${sessionId}:`, {
        errorMessage: error.message,
        sessionId
      });
    }
  }

  /**
   * Envía una actualización de estado de sesión a los clientes
   * @param {string} sessionId - ID de la sesión
   * @param {string} status - Estado de la sesión (qr_ready, connected, disconnected)
   * @param {Object} data - Datos adicionales
   */
  emitSessionStatus(sessionId, status, data = {}) {
    if (!this.isInitialized()) {
      logger.warn('Intento de emitir estado antes de inicializar Socket.IO');
      return;
    }

    if (!sessionId || !status) {
      logger.warn('SessionId o status vacío al intentar emitir estado');
      return;
    }
    
    this.io.to(sessionId).emit('session-status', {
      sessionId,
      status,
      ...data,
      timestamp: Date.now()
    });
    
    logger.debug(`Estado ${status} emitido para sesión ${sessionId}`);
  }

  /**
   * Emite el estado de escucha para una sesión
   * @param {string} sessionId - ID de la sesión
   * @param {boolean} isListening - Si está escuchando o no
   */
  emitListeningStatus(sessionId, isListening) {
    try {
      this.emitSessionStatus(sessionId, 'listening_status', {
        isListening,
        timestamp: Date.now()
      });
      
      logger.debug(`Estado de escucha ${isListening} emitido para sesión ${sessionId}`);
    } catch (error) {
      logger.error(`Error al emitir estado de escucha ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        isListening
      });
    }
  }

  /**
   * Emite una actualización a todos los clientes conectados
   * @param {string} event - Nombre del evento
   * @param {Object} data - Datos a enviar
   */
  emitToAll(event, data) {
    if (!this.isInitialized()) {
      logger.warn('Intento de emitir a todos antes de inicializar Socket.IO');
      return;
    }

    if (!event) {
      logger.warn('Nombre de evento vacío al intentar emitir a todos');
      return;
    }
    
    this.io.emit(event, {
      ...data,
      timestamp: Date.now()
    });
    
    logger.debug(`Evento ${event} emitido a todos los clientes`);
  }

  /**
   * Obtiene el número de conexiones activas para una sesión
   * @param {string} sessionId - ID de la sesión
   * @returns {number} - Número de conexiones
   */
  getConnectionCount(sessionId) {
    if (!sessionId || !this.connections.has(sessionId)) {
      return 0;
    }
    return this.connections.get(sessionId).size;
  }

  /**
   * Obtiene estadísticas del servicio
   * @returns {Object} - Estadísticas
   */
  getStats() {
    const totalConnections = Array.from(this.connections.values())
      .reduce((total, sockets) => total + sockets.size, 0);
    
    return {
      totalSessions: this.connections.size,
      totalConnections,
      isInitialized: this.isInitialized(),
      sessions: Array.from(this.connections.keys()).map(sessionId => ({
        sessionId,
        connections: this.getConnectionCount(sessionId)
      }))
    };
  }
}

module.exports = new SocketService();