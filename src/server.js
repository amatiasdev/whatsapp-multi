const express = require('express');
const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const sessionController = require('./controllers/sessionController');
const whatsappService = require('./services/whatsappService');
const socketService = require('./services/socketService');

// Validar configuración al inicio (si existe el método validate)
try {
  if (typeof config.validate === 'function') {
    config.validate();
    logger.info('Configuración validada correctamente');
  }
} catch (error) {
  logger.error('Error en configuración:', { errorMessage: error.message });
  process.exit(1);
}

// Crear aplicación Express
const app = express();

// Crear servidor HTTP a partir de la app Express
const server = http.createServer(app);

// Inicializar servicio de Socket.IO con el servidor HTTP
socketService.initialize(server);
logger.info('Servicio de Socket.IO inicializado');

// Middleware para parsear JSON con límite aumentado
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware para CORS básico
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Middleware mejorado para logging de peticiones
app.use((req, res, next) => {
  const start = Date.now();
  
  // Capturar información básica de la request sin referencias circulares
  const logData = {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    contentLength: req.get('Content-Length') || 0
  };
  
  // Log al finalizar la response
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[logLevel](`${req.method} ${req.url} ${res.statusCode} ${duration}ms`, {
      ...logData,
      statusCode: res.statusCode,
      responseTime: duration,
      contentLength: res.get('Content-Length') || 0
    });
  });
  
  next();
});

// Ruta de verificación de salud mejorada
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'UP', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Ruta mejorada para obtener información del sistema
app.get('/api/system/status', async (req, res) => {
  try {
    const sessions = await whatsappService.getAllSessions();
    const socketStats = socketService.getStats ? socketService.getStats() : { totalConnections: 0, totalSessions: 0 };
    
    // Obtener información del sistema
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeSessions: sessions.length,
      maxSessions: config.maxSessions,
      nodeVersion: process.version,
      platform: process.platform,
      environment: config.nodeEnv || process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      socketConnections: socketStats.totalConnections,
      socketSessions: socketStats.totalSessions
    };
    
    // Calcular uso de memoria por sesión
    if (sessions.length > 0) {
      systemInfo.memoryPerSession = Math.round(systemInfo.memory.rss / sessions.length);
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
    logger.error('Error al obtener estado del sistema:', {
      errorMessage: error.message,
      stack: error.stack
    });
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
app.get('/session/:sessionId/connection-status', sessionController.checkConnectionStatus);
app.delete('/api/session/:sessionId', sessionController.cleanupSession);

/**
 * @route GET /api/sessions/:sessionId/chats
 * @description Obtiene la lista de chats para una sesión con paginación
 */
app.get('/api/sessions/:sessionId/chats', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { 
      refresh = 'false', 
      limit = '50', 
      offset = '0',
      basic = 'false' // Nuevo parámetro para chats básicos
    } = req.query;
    
    const forceRefresh = refresh === 'true';
    const isBasic = basic === 'true';
    const chatLimit = Math.min(parseInt(limit) || 50, 100); // Máximo 100 chats
    const chatOffset = parseInt(offset) || 0;

    // Validar sessionId
    if (!sessionId || sessionId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'sessionId es requerido'
      });
    }

    logger.info(`Solicitando chats para sesión ${sessionId}`, {
      refresh: forceRefresh,
      basic: isBasic,
      limit: chatLimit,
      offset: chatOffset
    });

    // Verificar que la sesión existe en el servicio
    const sessionStatus = await whatsappService.getSessionStatus(sessionId);
    if (!sessionStatus.exists) {
      logger.warn(`Sesión ${sessionId} no encontrada`);
      return res.status(404).json({
        status: 'error',
        message: `Sesión ${sessionId} no encontrada`
      });
    }
    
    // Verificar que está conectada
    if (!sessionStatus.isConnected) {
      logger.warn(`Sesión ${sessionId} no está conectada`);
      return res.status(400).json({
        status: 'error',
        message: `La sesión ${sessionId} no está conectada a WhatsApp`,
        currentStatus: sessionStatus.status
      });
    }

    // Obtener lista de chats (básicos o completos)
    let result;
    if (isBasic) {
      result = await whatsappService.getBasicSessionChats(sessionId, chatLimit, chatOffset);
    } else {
      result = await whatsappService.getSessionChats(sessionId, forceRefresh, chatLimit, chatOffset);
    }
    
    logger.info(`Retornando ${result.chats.length} chats para sesión ${sessionId}`, {
      total: result.pagination?.total || result.total,
      basic: isBasic
    });
    
    return res.json({
      ...result,
      sessionId,
      timestamp: Date.now()
    });
    
  } catch (error) {
    logger.error(`Error al obtener chats para sesión ${req.params.sessionId}:`, {
      errorMessage: error.message,
      sessionId: req.params.sessionId,
      stack: error.stack
    });
    
    // Manejar errores específicos
    if (error.message.includes('no está conectado')) {
      return res.status(400).json({
        status: 'error',
        message: 'La sesión de WhatsApp no está conectada',
        code: 'SESSION_NOT_CONNECTED'
      });
    }
    
    if (error.message.includes('no encontrada')) {
      return res.status(404).json({
        status: 'error',
        message: 'Sesión no encontrada',
        code: 'SESSION_NOT_FOUND'
      });
    }
    
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Error interno del servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Nueva ruta adicional para chats básicos (más rápida)
app.get('/api/sessions/:sessionId/chats/basic', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit = '20', offset = '0' } = req.query;

    if (!sessionId || sessionId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'sessionId es requerido'
      });
    }

    logger.info(`Solicitando chats básicos para sesión ${sessionId}`);

    const chatLimit = Math.min(parseInt(limit) || 20, 50); // Máximo 50 para básicos
    const chatOffset = parseInt(offset) || 0;

    const result = await whatsappService.getBasicSessionChats(sessionId, chatLimit, chatOffset);
    
    logger.info(`Retornando ${result.chats.length} chats básicos para sesión ${sessionId}`);
    
    return res.json(result);

  } catch (error) {
    logger.error(`Error al obtener chats básicos para sesión ${req.params.sessionId}:`, {
      errorMessage: error.message,
      sessionId: req.params.sessionId
    });
    
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Error al obtener chats básicos'
    });
  }
});

/**
 * @route PUT /api/sessions/:sessionId/chats/:chatId/listening
 * @description Actualiza el estado de escucha de un chat
 */
app.put('/api/sessions/:sessionId/chats/:chatId/listening', async (req, res) => {
  try {
    const { sessionId, chatId } = req.params;
    const { isListening } = req.body;
    
    // Validar parámetros
    if (!sessionId || sessionId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'sessionId es requerido'
      });
    }
    
    if (!chatId || chatId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'chatId es requerido'
      });
    }
    
    if (isListening === undefined || typeof isListening !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        message: 'Se requiere el parámetro isListening (boolean)'
      });
    }
    
    logger.info(`Actualizando estado de escucha para chat ${chatId} en sesión ${sessionId} a ${isListening}`);
    
    // Verificar que la sesión existe
    const sessionStatus = await whatsappService.getSessionStatus(sessionId);
    if (!sessionStatus.exists) {
      logger.error(`Sesión ${sessionId} no encontrada`);
      return res.status(404).json({
        status: 'error',
        message: `Sesión ${sessionId} no encontrada`
      });
    }
    
    // Actualizar estado de escucha
    const result = await whatsappService.updateChatListeningStatus(sessionId, chatId, isListening);
    
    logger.info(`Estado de escucha actualizado correctamente para chat ${chatId}`);
    return res.json({
      status: 'success',
      chatId,
      isListening,
      result,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error(`Error al actualizar estado de escucha para chat ${req.params.chatId}:`, {
      errorMessage: error.message,
      sessionId: req.params.sessionId,
      chatId: req.params.chatId,
      stack: error.stack
    });
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Error interno del servidor'
    });
  }
});

// Endpoint adicional para obtener información detallada de una sesión
app.get('/api/sessions/:sessionId/info', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId || sessionId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'sessionId es requerido'
      });
    }
    
    // Verificar si el método existe antes de llamarlo
    if (typeof whatsappService.getSessionInfo === 'function') {
      const sessionInfo = await whatsappService.getSessionInfo(sessionId);
      return res.json({
        status: 'success',
        data: sessionInfo,
        timestamp: Date.now()
      });
    } else {
      // Fallback usando getSessionStatus
      const sessionStatus = await whatsappService.getSessionStatus(sessionId);
      return res.json({
        status: 'success',
        data: sessionStatus,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    logger.error(`Error al obtener información de sesión ${req.params.sessionId}:`, {
      errorMessage: error.message,
      sessionId: req.params.sessionId,
      stack: error.stack
    });
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Error interno del servidor'
    });
  }
});

// Middleware para rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Ruta ${req.method} ${req.originalUrl} no encontrada`
  });
});

// Middleware mejorado para manejo de errores
app.use((err, req, res, next) => {
  logger.error('Error no controlado:', {
    errorMessage: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body ? 'present' : 'absent'
  });
  
  // No exponer detalles del error en producción
  const nodeEnv = config.nodeEnv || process.env.NODE_ENV || 'development';
  const errorMessage = nodeEnv === 'production' 
    ? 'Error interno del servidor' 
    : err.message;
  
  res.status(err.status || 500).json({ 
    success: false, 
    error: errorMessage,
    timestamp: Date.now()
  });
});

// Función para cerrar el servidor limpiamente
async function gracefulShutdown(signal) {
  logger.info(`Señal ${signal} recibida, cerrando servidor...`);
  
  try {
    // Obtener todas las sesiones activas
    const sessions = await whatsappService.getAllSessions();
    
    // Limpiar sesiones activas
    for (const session of sessions) {
      try {
        await whatsappService.cleanupSession(session.sessionId);
        logger.info(`Sesión ${session.sessionId} cerrada correctamente`);
      } catch (error) {
        logger.error(`Error al cerrar sesión ${session.sessionId}:`, {
          errorMessage: error.message
        });
      }
    }
    
    // Cerrar servidor HTTP
    server.close(() => {
      logger.info('Servidor HTTP cerrado');
      process.exit(0);
    });
    
    // Forzar cierre después de 10 segundos
    setTimeout(() => {
      logger.warn('Forzando cierre del servidor');
      process.exit(1);
    }, 10000);
    
  } catch (error) {
    logger.error('Error durante el cierre del servidor:', {
      errorMessage: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Iniciar el servidor usando el server HTTP
const PORT = config.port;
server.listen(PORT, () => {
  const nodeEnv = config.nodeEnv || process.env.NODE_ENV || 'development';
  logger.info(`Servidor ejecutándose en modo ${nodeEnv} en puerto ${PORT}`);
  logger.info(`Configuración cargada: Max Sessions=${config.maxSessions}, Chunk Size=${config.messageChunkSize}, Chunk Interval=${config.chunkSendIntervalMs}ms`);
});

// Manejo de señales para cierre limpio
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Capturar excepciones no controladas con mejor logging
process.on('uncaughtException', (err) => {
  logger.error('Excepción no controlada:', {
    errorMessage: err.message,
    stack: err.stack,
    timestamp: Date.now()
  });
  
  // En desarrollo, detener el proceso
  const nodeEnv = config.nodeEnv || process.env.NODE_ENV || 'development';
  if (nodeEnv === 'development') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada no controlada:', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise.toString(),
    timestamp: Date.now()
  });
  
  // En desarrollo, detener el proceso
  const nodeEnv = config.nodeEnv || process.env.NODE_ENV || 'development';
  if (nodeEnv === 'development') {
    process.exit(1);
  }
});