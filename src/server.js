const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const sessionController = require('./controllers/sessionController');
const whatsappService = require('./services/whatsappService');

// Crear aplicación Express
const app = express();

// Middleware para parsear JSON
app.use(express.json());

// Middleware para logging de peticiones
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Ruta de verificación de salud
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/api/system/status', async (req, res) => {
  try {
    const sessionsCount = await whatsappService.getAllSessions();
    
    // Obtener información del sistema
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeSessions: sessionsCount.length,
      maxSessions: config.maxSessions,
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString()
    };
    
    // Calcular uso de memoria por sesión
    if (sessionsCount.length > 0) {
      systemInfo.memoryPerSession = Math.round(systemInfo.memory.rss / sessionsCount.length);
    }
    
    // Formatear algunos valores para mejor legibilidad
    systemInfo.memory.rss = `${Math.round(systemInfo.memory.rss / 1024 / 1024)} MB`;
    systemInfo.memory.heapTotal = `${Math.round(systemInfo.memory.heapTotal / 1024 / 1024)} MB`;
    systemInfo.memory.heapUsed = `${Math.round(systemInfo.memory.heapUsed / 1024 / 1024)} MB`;
    if (systemInfo.memoryPerSession) {
      systemInfo.memoryPerSession = `${Math.round(systemInfo.memoryPerSession / 1024 / 1024)} MB`;
    }
    systemInfo.uptime = `${Math.floor(systemInfo.uptime / 3600)}h ${Math.floor((systemInfo.uptime % 3600) / 60)}m`;
    
    return res.status(200).json(systemInfo);
  } catch (error) {
    logger.error('Error al obtener estado del sistema:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Error al obtener estado del sistema' 
    });
  }
});

// Rutas para manejo de sesiones
app.post('/api/session/initialize', sessionController.initializeSession);
app.post('/api/session/start-listening', sessionController.startListening);
app.post('/api/session/stop-listening', sessionController.stopListening);
app.get('/api/session/:sessionId/status', sessionController.getSessionStatus);
app.get('/api/sessions', sessionController.getAllSessions);
app.delete('/api/session/:sessionId', sessionController.cleanupSession);

// Middleware para manejo de errores
app.use((err, req, res, next) => {
  logger.error('Error no controlado:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Error interno del servidor' 
  });
});

// Iniciar el servidor
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`Servidor escuchando en el puerto ${PORT}`);
  logger.info(`Configuración cargada: Max Sessions=${config.maxSessions}, Chunk Size=${config.messageChunkSize}, Chunk Interval=${config.chunkSendIntervalMs}ms`);
});

// Manejo de señales para cierre limpio
process.on('SIGTERM', () => {
  logger.info('Señal SIGTERM recibida, cerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Señal SIGINT recibida, cerrando servidor...');
  process.exit(0);
});

// Capturar excepciones no controladas
process.on('uncaughtException', (err) => {
  logger.error('Excepción no controlada:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada no controlada:', reason);
});