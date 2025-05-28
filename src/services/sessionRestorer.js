const fs = require('fs');
const path = require('path');
const whatsappService = require('./whatsappService');
const logger = require('../utils/logger');

const sessionsPath = path.join(__dirname, '../../sessions');

async function restoreSessionsOnStart() {
  try {
    const folders = fs.readdirSync(sessionsPath, { withFileTypes: true });

    for (const entry of folders) {
      if (entry.isDirectory()) {
        const sessionId = entry.name;
        logger.info(`🔄 Restaurando sesión desde disco: ${sessionId}`);

        try {
          await whatsappService.initializeClient(sessionId, { fromDisk: true });
          logger.info(`✅ Sesión ${sessionId} restaurada correctamente`);
        } catch (error) {
          logger.error(`❌ Error al restaurar sesión ${sessionId}:`, {
            errorMessage: error.message,
            stack: error.stack
          });
        }
      }
    }
  } catch (err) {
    logger.error('🛑 Error global al intentar restaurar sesiones:', {
      errorMessage: err.message,
      stack: err.stack
    });
  }
}

module.exports = restoreSessionsOnStart;
