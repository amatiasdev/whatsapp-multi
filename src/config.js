require('dotenv').config();
const path = require('path');

module.exports = {
  // Servidor
  port: process.env.PORT || 3000,
  webPort : process.env.WEB_PORT || 3001,
  // WhatsApp
  sessionDataPath: process.env.SESSION_DATA_PATH || path.join(__dirname, '../sessions'),
  maxSessions: parseInt(process.env.MAX_SESSIONS || '30', 10),
  
  // Webhooks
  n8nWebhookUrl: process.env.BACKEND_WEBHOOK_URL || 'http://localhost:5678/webhook/whatsapp-messages',
  messageChunkSize: parseInt(process.env.MESSAGE_CHUNK_SIZE || '5', 10),
  chunkSendIntervalMs: parseInt(process.env.CHUNK_SEND_INTERVAL_MS || '30000', 10),
  messageFilters: {
    ignoreStatus: process.env.IGNORE_STATUS !== 'false', // Por defecto true
    ignoreGroups: process.env.IGNORE_GROUPS === 'true', // Por defecto false
    ignoreNonGroups: process.env.IGNORE_NON_GROUPS === 'true', // Por defecto false
    ignoreBroadcast: process.env.IGNORE_BROADCAST !== 'false', // Por defecto true
    allowedGroups: process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',') : [], // Lista de IDs de grupos permitidos
    allowedContacts: process.env.ALLOWED_CONTACTS ? process.env.ALLOWED_CONTACTS.split(',') : [] // Lista de contactos permitidos
  },
};