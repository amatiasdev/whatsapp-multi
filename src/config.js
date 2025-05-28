require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Crear directorio de sesiones si no existe
const defaultSessionPath = path.join(__dirname, '../sessions');
const sessionDataPath = process.env.SESSION_DATA_PATH || defaultSessionPath;
if (!fs.existsSync(sessionDataPath)) {
  fs.mkdirSync(sessionDataPath, { recursive: true });
}

module.exports = {
  // Servidor
  port: parseInt(process.env.PORT || '3000', 10),
  webPort: parseInt(process.env.WEB_PORT || '3001', 10),
  
  // Entorno
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // WhatsApp
  sessionDataPath,
  maxSessions: parseInt(process.env.MAX_SESSIONS || '30', 10),
  
  // Timeouts y reintentos
  clientTimeout: parseInt(process.env.CLIENT_TIMEOUT || '45000', 10), // 45 segundos
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  retryDelay: parseInt(process.env.RETRY_DELAY || '5000', 10), // 5 segundos
  
  // Webhooks
  n8nWebhookUrl: process.env.BACKEND_WEBHOOK_URL || 'http://localhost:5678/webhook/whatsapp-messages',
  webhookTimeout: parseInt(process.env.WEBHOOK_TIMEOUT || '30000', 10), // 30 segundos
  webhookRetries: parseInt(process.env.WEBHOOK_RETRIES || '3', 10),
  
  // Mensajes y chunks
  messageChunkSize: parseInt(process.env.MESSAGE_CHUNK_SIZE || '5', 10),
  chunkSendIntervalMs: parseInt(process.env.CHUNK_SEND_INTERVAL_MS || '30000', 10), // 30 segundos
  maxMessageBuffer: parseInt(process.env.MAX_MESSAGE_BUFFER || '1000', 10),
  
  // Filtros de mensajes
  messageFilters: {
    ignoreStatus: process.env.IGNORE_STATUS !== 'false', // Por defecto true
    ignoreGroups: process.env.IGNORE_GROUPS === 'true', // Por defecto false
    ignoreNonGroups: process.env.IGNORE_NON_GROUPS === 'true', // Por defecto false
    ignoreBroadcast: process.env.IGNORE_BROADCAST !== 'false', // Por defecto true
    allowedGroups: process.env.ALLOWED_GROUPS ? 
      process.env.ALLOWED_GROUPS.split(',').map(id => id.trim()).filter(id => id) : [], 
    allowedContacts: process.env.ALLOWED_CONTACTS ? 
      process.env.ALLOWED_CONTACTS.split(',').map(id => id.trim()).filter(id => id) : []
  },
  
  // Cache y limpieza
  cacheCleanupInterval: parseInt(process.env.CACHE_CLEANUP_INTERVAL || '7200000', 10), // 2 horas
  sessionCleanupInterval: parseInt(process.env.SESSION_CLEANUP_INTERVAL || '43200000', 10), // 12 horas
  qrExpirationTime: parseInt(process.env.QR_EXPIRATION_TIME || '60000', 10), // 1 minuto
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logMaxFiles: parseInt(process.env.LOG_MAX_FILES || '5', 10),
  logMaxSize: parseInt(process.env.LOG_MAX_SIZE || '10485760', 10), // 10MB
  
  // Socket.IO
  socketPingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || '60000', 10),
  socketPingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || '25000', 10),
  socketConnectTimeout: parseInt(process.env.SOCKET_CONNECT_TIMEOUT || '45000', 10),
  
  // Database (si se usa)
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/whatsapp-api',
  mongoOptions: {
    // Remover opciones deprecadas
    maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE || '10', 10),
    serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT || '5000', 10),
    socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT || '45000', 10),
    bufferMaxEntries: 0,
    bufferCommands: false
  },
  
  // Validación de configuración
  validate() {
    const errors = [];
    
    if (this.maxSessions < 1) {
      errors.push('MAX_SESSIONS debe ser mayor a 0');
    }
    
    if (this.messageChunkSize < 1) {
      errors.push('MESSAGE_CHUNK_SIZE debe ser mayor a 0');
    }
    
    if (this.chunkSendIntervalMs < 1000) {
      errors.push('CHUNK_SEND_INTERVAL_MS debe ser al menos 1000ms');
    }
    
    if (!this.n8nWebhookUrl.startsWith('http')) {
      errors.push('BACKEND_WEBHOOK_URL debe ser una URL válida');
    }
    
    if (errors.length > 0) {
      throw new Error(`Errores de configuración:\n${errors.join('\n')}`);
    }
    
    return true;
  }
};