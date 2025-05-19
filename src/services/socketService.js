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
    this.io = socketIO(server, {
      cors: {
        origin: "*", // En producción, limitar a dominios específicos
        methods: ["GET", "POST"]
      }
    });

    this.io.on('connection', (socket) => {
      logger.info(`Socket conectado: ${socket.id}`);

      // Manejar suscripción a una sesión
      socket.on('subscribe', (sessionId) => {
        // Crear set de sockets si no existe para esta sesión
        if (!this.connections.has(sessionId)) {
          this.connections.set(sessionId, new Set());
        }
        
        // Añadir este socket a la sesión
        this.connections.get(sessionId).add(socket.id);
        
        // Unir al socket a una sala con el ID de la sesión
        socket.join(sessionId);
        
        logger.info(`Socket ${socket.id} suscrito a la sesión ${sessionId}`);
      });

      // Manejar cancelación de suscripción
      socket.on('unsubscribe', (sessionId) => {
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
      });

      // Manejar desconexión
      socket.on('disconnect', () => {
        logger.info(`Socket desconectado: ${socket.id}`);
        
        // Eliminar este socket de todas las sesiones
        for (const [sessionId, sockets] of this.connections.entries()) {
          if (sockets.has(socket.id)) {
            sockets.delete(socket.id);
            
            // Si no quedan sockets, eliminar la sesión
            if (sockets.size === 0) {
              this.connections.delete(sessionId);
            }
            
            logger.info(`Socket ${socket.id} eliminado de la sesión ${sessionId}`);
          }
        }
      });
    });

    logger.info('Servicio de Socket.IO inicializado');
    return this.io;
  }

  /**
   * Envía un código QR a todos los clientes suscritos a una sesión
   * @param {string} sessionId - ID de la sesión
   * @param {string} qr - Código QR
   */
  emitQRCode(sessionId, qr) {
    if (!this.io) {
      logger.warn('Intento de emitir QR antes de inicializar Socket.IO');
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
    if (!expiresAt) {
      expiresAt = Date.now() + 60000; // 60 segundos por defecto
    }
    
    this.emitQRCode(sessionId, qrCode);
    this.emitSessionStatus(sessionId, 'qr_ready', {
      expiresAt: expiresAt
    });
    
    logger.info(`QR emitido y estado actualizado para sesión ${sessionId}`);
  }

  /**
   * Marca una sesión como conectada
   * @param {string} sessionId - ID de la sesión
   */
  markSessionConnected(sessionId) {
    this.emitSessionStatus(sessionId, 'connected', {
      connectedAt: Date.now()
    });
    
    logger.info(`Sesión ${sessionId} marcada como conectada vía socket`);
  }

  /**
   * Marca una sesión como desconectada
   * @param {string} sessionId - ID de la sesión
   */
  markSessionDisconnected(sessionId) {
    this.emitSessionStatus(sessionId, 'disconnected', {
      disconnectedAt: Date.now()
    });
    
    logger.info(`Sesión ${sessionId} marcada como desconectada vía socket`);
  }

  /**
   * Marca un código QR como expirado
   * @param {string} sessionId - ID de la sesión
   */
  markQRExpired(sessionId) {
    this.emitSessionStatus(sessionId, 'qr_expired', {
      expiredAt: Date.now()
    });
    
    logger.info(`QR de sesión ${sessionId} marcado como expirado vía socket`);
  }

  /**
   * Envía una actualización de estado de sesión a los clientes
   * @param {string} sessionId - ID de la sesión
   * @param {string} status - Estado de la sesión (qr_ready, connected, disconnected)
   * @param {Object} data - Datos adicionales
   */
  emitSessionStatus(sessionId, status, data = {}) {
    if (!this.io) {
      logger.warn('Intento de emitir estado antes de inicializar Socket.IO');
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
   * Emite una actualización a todos los clientes conectados
   * @param {string} event - Nombre del evento
   * @param {Object} data - Datos a enviar
   */
  emitToAll(event, data) {
    if (!this.io) {
      logger.warn('Intento de emitir a todos antes de inicializar Socket.IO');
      return;
    }
    
    this.io.emit(event, {
      ...data,
      timestamp: Date.now()
    });
    
    logger.debug(`Evento ${event} emitido a todos los clientes`);
  }
}

module.exports = new SocketService();