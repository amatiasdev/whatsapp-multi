/**
 * qrWebServer.js
 * Servidor web dedicado para mostrar códigos QR
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcode = require('qrcode');
const fs = require('fs');
const axios = require('axios');
const logger = require('./src/utils/logger');

// Importar el servicio QR
const qrService = require('./src/services/qrService');

// URL base del API principal
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api';

// Inicializar Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configurar carpeta de archivos estáticos
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'qr.html'));
});

// Ruta para una sesión específica
app.get('/qr/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  res.sendFile(path.join(__dirname, 'src', 'public', 'qr.html'));
});

// Endpoint API para obtener el estado de conexión (proxy al servidor principal)
app.get('/api/session/:sessionId/connection-status', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    
    // Intentar obtener desde el servidor principal
    try {
      const response = await axios.get(`${API_BASE_URL}/session/${sessionId}/connection-status`);
      return res.status(response.status).json(response.data);
    } catch (apiError) {
      logger.warn(`Error al obtener estado desde API: ${apiError.message}`);
      
      // Si no se puede conectar al API, usar información local
      const qrData = qrService.getQR(sessionId);
      const isConnected = qrService.isSessionConnected(sessionId);
      
      let connectionStatus = 'disconnected';
      if (isConnected) {
        connectionStatus = 'connected';
      } else if (qrData) {
        connectionStatus = 'waiting_for_scan';
      }
      
      return res.status(200).json({
        success: true,
        sessionId,
        connectionStatus,
        details: {
          exists: true,
          isConnected,
          hasQR: !!qrData
        }
      });
    }
  } catch (error) {
    logger.error(`Error al procesar solicitud de estado: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Manejar conexiones de Socket.IO
io.on('connection', (socket) => {
  logger.info('Nuevo cliente web conectado');
  
  // Cuando el cliente solicita un QR específico
  socket.on('requestQR', (sessionId) => {
    logger.debug(`Cliente solicitó QR para sesión: ${sessionId}`);
    
    const qrData = qrService.getQR(sessionId);
    
    if (qrData && qrData.qr) {
      // Convertir el código QR a URL de imagen
      qrcode.toDataURL(qrData.qr, (err, url) => {
        if (err) {
          logger.error('Error al generar QR para web:', err);
          socket.emit('qrStatus', { 
            sessionId,
            status: 'error',
            message: 'Error al generar QR'
          });
          return;
        }
        
        socket.emit('qrCode', { 
          sessionId,
          qr: url,
          expiryTime: qrData.timestamp
        });
      });
    } else if (qrService.isSessionConnected(sessionId)) {
      // Sesión ya conectada
      socket.emit('clientReady', { sessionId });
    } else {
      // No hay QR disponible
      socket.emit('qrStatus', { 
        sessionId,
        status: 'unavailable', 
        message: 'No hay código QR disponible para esta sesión'
      });
    }
  });
  
  // Cuando se solicita la lista de sesiones
  socket.on('requestSessions', () => {
    const sessions = qrService.getAllSessions();
    socket.emit('sessionsList', sessions);
  });
});

// Iniciar verificador periódico de QR
const CHECK_INTERVAL = 5000; // 5 segundos
setInterval(() => {
  const sessions = qrService.getAllSessions();
  
  sessions.forEach(session => {
    if (session.hasQR) {
      const qrData = qrService.getQR(session.sessionId);
      
      if (qrData) {
        // Verificar si está a punto de expirar (menos de 10 segundos)
        const timeLeft = qrData.timestamp - Date.now();
        if (timeLeft <= 10000 && timeLeft > 0) {
          // Emitir advertencia de expiración
          io.emit('qrExpiringWarning', {
            sessionId: session.sessionId,
            remainingTime: Math.floor(timeLeft / 1000)
          });
        } else if (timeLeft <= 0) {
          // Emitir expiración
          io.emit('qrExpired', { sessionId: session.sessionId });
        }
      }
    }
  });
}, CHECK_INTERVAL);

// Puerto para el servidor web
const PORT = process.env.QR_WEB_PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Servidor web para QR iniciado en el puerto ${PORT}`);
});