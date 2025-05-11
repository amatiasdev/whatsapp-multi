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

// Inicializar Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Importar el servicio QR
const qrService = require('./src/services/qrService');

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

// Manejar conexiones de Socket.IO
io.on('connection', (socket) => {
  console.log('Nuevo cliente web conectado');
  
  // Cuando el cliente solicita un QR específico
  socket.on('requestQR', (sessionId) => {
    console.log(`Cliente solicitó QR para sesión: ${sessionId}`);
    
    const qrData = qrService.getQR(sessionId);
    
    if (qrData && qrData.qr) {
      // Convertir el código QR a URL de imagen
      qrcode.toDataURL(qrData.qr, (err, url) => {
        if (err) {
          console.error('Error al generar QR para web:', err);
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
  console.log(`Servidor web para QR iniciado en el puerto ${PORT}`);
});