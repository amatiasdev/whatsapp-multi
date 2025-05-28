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
  clientTimeout: parseInt(process.env.CLIENT_TIMEOUT || '190000', 10), // 45 segundos
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
  
  // Nuevas configuraciones para reconexión y gestión de sesiones
  reconnection: {
    maxAttempts: parseInt(process.env.RECONNECTION_MAX_ATTEMPTS || '5', 10),
    baseDelayMs: parseInt(process.env.RECONNECTION_BASE_DELAY || '5000', 10), // 5 segundos
    maxDelayMs: parseInt(process.env.RECONNECTION_MAX_DELAY || '300000', 10), // 5 minutos
    backoffFactor: parseFloat(process.env.RECONNECTION_BACKOFF_FACTOR || '2.0') // Factor de backoff exponencial
  },
  
  // Configuraciones de limpieza automática
  cleanup: {
    enabled: process.env.AUTO_CLEANUP_ENABLED !== 'false', // Por defecto habilitado
    intervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '7200000', 10), // 2 horas
    sessionExpiryMs: parseInt(process.env.SESSION_EXPIRY_MS || '86400000', 10), // 24 horas
    inactiveThresholdMs: parseInt(process.env.INACTIVE_THRESHOLD_MS || '7200000', 10), // 2 horas
    forceCleanupAfterMs: parseInt(process.env.FORCE_CLEANUP_AFTER_MS || '259200000', 10) // 3 días
  },
  
  // Límites de sesiones
  sessionLimits: {
    maxPerUser: parseInt(process.env.MAX_SESSIONS_PER_USER || '3', 10),
    maxGlobal: parseInt(process.env.MAX_SESSIONS || '30', 10),
    maxReconnectionAttempts: parseInt(process.env.MAX_RECONNECTION_ATTEMPTS || '5', 10)
  },
  
  // Configuraciones de salud del sistema
  health: {
    checkIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10), // 5 minutos
    criticalThresholds: {
      systemUsagePercent: parseInt(process.env.CRITICAL_SYSTEM_USAGE || '90', 10),
      problematicSessionsPercent: parseInt(process.env.CRITICAL_PROBLEMATIC_SESSIONS || '30', 10),
      disconnectedSessionsPercent: parseInt(process.env.CRITICAL_DISCONNECTED_SESSIONS || '50', 10)
    }
  },
  
  // Configuraciones de monitoreo
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    logDetailedStats: process.env.LOG_DETAILED_STATS === 'true',
    alertOnCriticalIssues: process.env.ALERT_ON_CRITICAL !== 'false', // Por defecto habilitado
    statsRetentionDays: parseInt(process.env.STATS_RETENTION_DAYS || '7', 10)
  },
  
  // Configuraciones de performance
  performance: {
    maxBufferSizePerChat: parseInt(process.env.MAX_BUFFER_SIZE_PER_CHAT || '100', 10),
    maxTotalBufferSize: parseInt(process.env.MAX_TOTAL_BUFFER_SIZE || '1000', 10),
    gcIntervalMs: parseInt(process.env.GC_INTERVAL_MS || '1800000', 10), // 30 minutos
    memoryWarningThresholdMB: parseInt(process.env.MEMORY_WARNING_THRESHOLD_MB || '512', 10)
  },
  
  // Configuraciones de seguridad
  security: {
    sessionIdValidation: process.env.STRICT_SESSION_ID_VALIDATION !== 'false',
    maxSessionIdLength: parseInt(process.env.MAX_SESSION_ID_LENGTH || '50', 10),
    allowedSessionIdChars: process.env.ALLOWED_SESSION_ID_CHARS || '^[a-zA-Z0-9_-]+$',
    rateLimitRequests: process.env.RATE_LIMIT_REQUESTS === 'true',
    maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '60', 10)
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
  },
  
  // Validación extendida
  validateExtended() {
    const errors = [];
    
    // Validar configuraciones de reconexión
    if (this.reconnection.maxAttempts < 1 || this.reconnection.maxAttempts > 20) {
      errors.push('RECONNECTION_MAX_ATTEMPTS debe estar entre 1 y 20');
    }
    
    if (this.reconnection.baseDelayMs < 1000 || this.reconnection.baseDelayMs > 60000) {
      errors.push('RECONNECTION_BASE_DELAY debe estar entre 1000ms y 60000ms');
    }
    
    if (this.reconnection.backoffFactor < 1.0 || this.reconnection.backoffFactor > 5.0) {
      errors.push('RECONNECTION_BACKOFF_FACTOR debe estar entre 1.0 y 5.0');
    }
    
    // Validar configuraciones de limpieza
    if (this.cleanup.intervalMs < 300000) { // Mínimo 5 minutos
      errors.push('CLEANUP_INTERVAL_MS debe ser al menos 300000ms (5 minutos)');
    }
    
    if (this.cleanup.sessionExpiryMs < 3600000) { // Mínimo 1 hora
      errors.push('SESSION_EXPIRY_MS debe ser al menos 3600000ms (1 hora)');
    }
    
    // Validar límites de sesiones
    if (this.sessionLimits.maxPerUser < 1 || this.sessionLimits.maxPerUser > 10) {
      errors.push('MAX_SESSIONS_PER_USER debe estar entre 1 y 10');
    }
    
    if (this.sessionLimits.maxGlobal < this.sessionLimits.maxPerUser) {
      errors.push('MAX_SESSIONS debe ser mayor o igual que MAX_SESSIONS_PER_USER');
    }
    
    // Validar thresholds de salud
    const healthThresholds = this.health.criticalThresholds;
    if (healthThresholds.systemUsagePercent < 50 || healthThresholds.systemUsagePercent > 100) {
      errors.push('CRITICAL_SYSTEM_USAGE debe estar entre 50 y 100');
    }
    
    // Validar configuraciones de performance
    if (this.performance.maxBufferSizePerChat < 10 || this.performance.maxBufferSizePerChat > 1000) {
      errors.push('MAX_BUFFER_SIZE_PER_CHAT debe estar entre 10 y 1000');
    }
    
    // Validar configuraciones de seguridad
    if (this.security.maxSessionIdLength < 5 || this.security.maxSessionIdLength > 100) {
      errors.push('MAX_SESSION_ID_LENGTH debe estar entre 5 y 100');
    }
    
    if (errors.length > 0) {
      throw new Error(`Errores de configuración extendida:\n${errors.join('\n')}`);
    }
    
    return true;
  },
  
  // Método para obtener configuraciones de reconexión calculadas
  getReconnectionDelay(attempt) {
    const baseDelay = this.reconnection.baseDelayMs;
    const factor = this.reconnection.backoffFactor;
    const maxDelay = this.reconnection.maxDelayMs;
    
    const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
    
    // Añadir un poco de jitter para evitar el efecto "thundering herd"
    const jitter = Math.random() * 0.1 * delay; // 10% de jitter
    
    return Math.round(delay + jitter);
  },
  
  // Método para verificar si una sesión debería ser limpiada
  shouldCleanupSession(sessionData) {
    const now = Date.now();
    const lastActivity = sessionData.lastActivity || sessionData.createdAt || 0;
    const timeSinceActivity = now - lastActivity;
    
    // Condiciones para limpiar
    const isExpired = timeSinceActivity > this.cleanup.sessionExpiryMs;
    const isForceExpired = timeSinceActivity > this.cleanup.forceCleanupAfterMs;
    const hasTooManyRetries = (sessionData.reconnectionAttempts || 0) > this.sessionLimits.maxReconnectionAttempts;
    const isInactiveWithoutClient = !sessionData.client && timeSinceActivity > this.cleanup.inactiveThresholdMs;
    
    return {
      shouldCleanup: isExpired || isForceExpired || hasTooManyRetries || isInactiveWithoutClient,
      reasons: {
        isExpired,
        isForceExpired,
        hasTooManyRetries,
        isInactiveWithoutClient
      },
      timeSinceActivity,
      recommendedAction: isForceExpired ? 'force_cleanup' : 
                        hasTooManyRetries ? 'cleanup_retry_limit' :
                        isInactiveWithoutClient ? 'cleanup_inactive' :
                        'cleanup_expired'
    };
  },
  
  // Método para calcular la salud del sistema
  calculateSystemHealth(stats) {
    let healthScore = 100;
    const thresholds = this.health.criticalThresholds;
    
    // Penalizar por uso alto del sistema
    const usagePercent = (stats.total / this.sessionLimits.maxGlobal) * 100;
    if (usagePercent > thresholds.systemUsagePercent) {
      healthScore -= 30;
    } else if (usagePercent > thresholds.systemUsagePercent - 20) {
      healthScore -= 15;
    }
    
    // Penalizar por sesiones desconectadas
    const disconnectedPercent = ((stats.total - stats.connected) / stats.total) * 100;
    if (disconnectedPercent > thresholds.disconnectedSessionsPercent) {
      healthScore -= 25;
    }
    
    // Penalizar por alta inactividad
    const inactivePercent = (stats.inactive / stats.total) * 100;
    if (inactivePercent > 40) {
      healthScore -= 20;
    }
    
    // Penalizar por errores frecuentes
    if (stats.hasErrors > stats.total * 0.3) {
      healthScore -= 15;
    }
    
    // Penalizar por buffers grandes
    if (stats.totalBufferSize > this.performance.maxTotalBufferSize) {
      healthScore -= 10;
    }
    
    return {
      score: Math.max(0, Math.min(100, healthScore)),
      level: healthScore >= 80 ? 'excellent' :
             healthScore >= 60 ? 'good' :
             healthScore >= 40 ? 'warning' : 'critical',
      usagePercent: Math.round(usagePercent),
      disconnectedPercent: Math.round(disconnectedPercent),
      inactivePercent: Math.round(inactivePercent)
    };
  },
  
  // Método para obtener configuraciones de memoria
  getMemoryConfig() {
    return {
      warningThreshold: this.performance.memoryWarningThresholdMB * 1024 * 1024, // Convert to bytes
      maxBufferSize: this.performance.maxTotalBufferSize,
      gcInterval: this.performance.gcIntervalMs,
      shouldTriggerGC: () => {
        const usage = process.memoryUsage();
        return usage.heapUsed > (this.performance.memoryWarningThresholdMB * 1024 * 1024);
      }
    };
  },
  
  // Método para validar un sessionId
  validateSessionId(sessionId) {
    if (!this.security.sessionIdValidation) {
      return { valid: true };
    }
    
    if (!sessionId || typeof sessionId !== 'string') {
      return { 
        valid: false, 
        reason: 'SessionId debe ser una cadena no vacía' 
      };
    }
    
    if (sessionId.length > this.security.maxSessionIdLength) {
      return { 
        valid: false, 
        reason: `SessionId no puede exceder ${this.security.maxSessionIdLength} caracteres` 
      };
    }
    
    if (sessionId.length < 3) {
      return { 
        valid: false, 
        reason: 'SessionId debe tener al menos 3 caracteres' 
      };
    }
    
    const regex = new RegExp(this.security.allowedSessionIdChars);
    if (!regex.test(sessionId)) {
      return { 
        valid: false, 
        reason: 'SessionId contiene caracteres no válidos. Solo se permiten letras, números, guiones y guiones bajos' 
      };
    }
    
    // Verificar palabras reservadas
    const reservedWords = ['admin', 'system', 'api', 'webhook', 'health', 'stats'];
    if (reservedWords.includes(sessionId.toLowerCase())) {
      return { 
        valid: false, 
        reason: 'SessionId no puede usar palabras reservadas del sistema' 
      };
    }
    
    return { valid: true };
  }
};