/**
 * src/services/qrService.js
 * Servicio para almacenar y compartir códigos QR entre servidores
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
// Importante: importar socketService al final para evitar dependencia circular

class QRService {
  constructor() {
    this.qrCodes = new Map(); // sessionId -> { qr, timestamp }
    this.qrDir = path.join(process.cwd(), 'qr-codes');
    
    // Crear directorio para códigos QR si no existe
    if (!fs.existsSync(this.qrDir)) {
      fs.mkdirSync(this.qrDir, { recursive: true });
      logger.info(`Directorio para códigos QR creado: ${this.qrDir}`);
    }
  }

  /**
   * Guarda un código QR para una sesión específica
   */
  saveQR(sessionId, qr) {
    if (!sessionId || !qr) return false;

    // Guardar en memoria
    const expiresAt = Date.now() + 60000; // Validez de 60 segundos
    this.qrCodes.set(sessionId, {
      qr,
      timestamp: expiresAt
    });

    // Guardar en archivo
    const qrFilePath = path.join(this.qrDir, `${sessionId}.qr`);
    const qrData = JSON.stringify({
      qr,
      timestamp: expiresAt
    });

    try {
      fs.writeFileSync(qrFilePath, qrData);
      logger.debug(`QR guardado para sesión ${sessionId}`);
      
      // Obtener socketService aquí para evitar dependencia circular
      const socketService = require('./socketService');
      
      // Emitir el QR a través de sockets
      socketService.emitQRForSession(sessionId, qr, expiresAt);
      
      return true;
    } catch (error) {
      logger.error(`Error al guardar QR para sesión ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Obtiene un código QR para una sesión específica
   */
  getQR(sessionId) {
    // Primero intentar desde memoria
    if (this.qrCodes.has(sessionId)) {
      const qrData = this.qrCodes.get(sessionId);
      if (qrData.timestamp > Date.now()) {
        return qrData;
      } else {
        // QR expirado, eliminar
        this.qrCodes.delete(sessionId);
        
        // Obtener socketService aquí para evitar dependencia circular
        const socketService = require('./socketService');
        socketService.markQRExpired(sessionId);
      }
    }

    // Si no está en memoria, intentar desde archivo
    const qrFilePath = path.join(this.qrDir, `${sessionId}.qr`);
    if (fs.existsSync(qrFilePath)) {
      try {
        const qrData = JSON.parse(fs.readFileSync(qrFilePath, 'utf8'));
        if (qrData.timestamp > Date.now()) {
          // Guardar en memoria también
          this.qrCodes.set(sessionId, qrData);
          return qrData;
        } else {
          // QR expirado, eliminar archivo
          fs.unlinkSync(qrFilePath);
          
          // Obtener socketService aquí para evitar dependencia circular
          const socketService = require('./socketService');
          socketService.markQRExpired(sessionId);
        }
      } catch (error) {
        logger.error(`Error al leer QR para sesión ${sessionId}:`, error);
      }
    }

    return null;
  }

  /**
   * Marca una sesión como conectada (elimina el QR)
   */
  markSessionConnected(sessionId) {
    this.qrCodes.delete(sessionId);
    
    const qrFilePath = path.join(this.qrDir, `${sessionId}.qr`);
    if (fs.existsSync(qrFilePath)) {
      try {
        fs.unlinkSync(qrFilePath);
      } catch (error) {
        logger.error(`Error al eliminar archivo QR para sesión ${sessionId}:`, error);
      }
    }
    
    // Guardar estado de conexión
    const connectedFilePath = path.join(this.qrDir, `${sessionId}.connected`);
    try {
      fs.writeFileSync(connectedFilePath, Date.now().toString());
      
      // Obtener socketService aquí para evitar dependencia circular
      const socketService = require('./socketService');
      socketService.markSessionConnected(sessionId);
      
      logger.info(`Sesión ${sessionId} marcada como conectada`);
    } catch (error) {
      logger.error(`Error al guardar estado de conexión para sesión ${sessionId}:`, error);
    }
  }

  /**
   * Marca una sesión como desconectada
   */
  markSessionDisconnected(sessionId) {
    // Eliminar archivo de conexión si existe
    const connectedFilePath = path.join(this.qrDir, `${sessionId}.connected`);
    if (fs.existsSync(connectedFilePath)) {
      try {
        fs.unlinkSync(connectedFilePath);
      } catch (error) {
        logger.error(`Error al eliminar archivo de conexión para sesión ${sessionId}:`, error);
      }
    }
    
    // Obtener socketService aquí para evitar dependencia circular
    const socketService = require('./socketService');
    socketService.markSessionDisconnected(sessionId);
    
    logger.info(`Sesión ${sessionId} marcada como desconectada`);
  }

  /**
   * Verifica si una sesión está conectada
   */
  isSessionConnected(sessionId) {
    const connectedFilePath = path.join(this.qrDir, `${sessionId}.connected`);
    return fs.existsSync(connectedFilePath);
  }

  /**
   * Obtiene todas las sesiones con códigos QR disponibles
   */
  getAllSessions() {
    const sessions = [];
    
    // Escanear directorio de códigos QR
    try {
      const files = fs.readdirSync(this.qrDir);
      const qrFiles = files.filter(file => file.endsWith('.qr'));
      
      for (const file of qrFiles) {
        const sessionId = file.replace('.qr', '');
        const qrData = this.getQR(sessionId);
        
        if (qrData) {
          sessions.push({
            sessionId,
            hasQR: true,
            timestamp: qrData.timestamp
          });
        }
      }
      
      // Añadir también sesiones conectadas
      const connectedFiles = files.filter(file => file.endsWith('.connected'));
      for (const file of connectedFiles) {
        const sessionId = file.replace('.connected', '');
        
        // Solo añadir si no está ya en la lista
        if (!sessions.find(s => s.sessionId === sessionId)) {
          sessions.push({
            sessionId,
            hasQR: false,
            isConnected: true
          });
        } else {
          // Actualizar si ya está en la lista
          const session = sessions.find(s => s.sessionId === sessionId);
          session.isConnected = true;
        }
      }
    } catch (error) {
      logger.error('Error al leer directorio de códigos QR:', error);
    }
    
    return sessions;
  }
  
  /**
   * Envía la lista de sesiones a través de sockets
   */
  broadcastSessionsList() {
    const sessions = this.getAllSessions();
    // Obtener socketService aquí para evitar dependencia circular
    const socketService = require('./socketService');
    socketService.emitToAll('sessions-list', { sessions });
  }
}

// Exportar una instancia única
module.exports = new QRService();