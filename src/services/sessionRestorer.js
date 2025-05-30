const fs = require('fs');
const path = require('path');
const whatsappService = require('./whatsappService');
const logger = require('../utils/logger');
const socketService = require('./socketService');

const sessionsPath = path.join(__dirname, '../../sessions');

async function restoreSessionsOnStart() {
  try {
    logger.info('🔄 Iniciando proceso de restauración de sesiones desde disco...');
    
    // Verificar si existe el directorio de sesiones
    if (!fs.existsSync(sessionsPath)) {
      logger.info('📁 No existe directorio de sesiones, no hay nada que restaurar');
      return;
    }

    const folders = fs.readdirSync(sessionsPath, { withFileTypes: true });
    const sessionFolders = folders.filter(entry => entry.isDirectory());
    
    if (sessionFolders.length === 0) {
      logger.info('📭 No se encontraron sesiones para restaurar');
      return;
    }

    logger.info(`📦 Encontradas ${sessionFolders.length} sesiones para restaurar`);

    // ✅ Crear array de promesas de restauración
    const restorationPromises = [];

    for (const entry of sessionFolders) {
      const sessionId = entry.name.replace(/^session-/, '');
      logger.info(`🔄 Iniciando restauración de sesión: ${sessionId}`);

      try {
        // ✅ Inicializar cliente con opción fromDisk y obtener promesa
        await whatsappService.initializeClient(sessionId, { fromDisk: true });
        
        // ✅ Obtener la promesa de restauración para esta sesión
        const restorationPromise = whatsappService.getRestorationPromise(sessionId);
        
        if (restorationPromise) {
          // ✅ Agregar promesa al array con manejo de errores
          restorationPromises.push(
            restorationPromise
              .then(result => {
                socketService.markSessionConnected(sessionId);
                logger.info(`✅ Sesión ${sessionId} restaurada correctamente`, {
                  sessionId: result.sessionId,
                  status: result.status,
                  readyAt: result.readyAt
                });
                return { sessionId, success: true, result };
              })
              .catch(error => {
                logger.error(`❌ Error al restaurar sesión ${sessionId}:`, {
                  errorMessage: error.message,
                  sessionId
                });
                return { sessionId, success: false, error: error.message };
              })
          );
        } else {
          logger.warn(`⚠️ No se pudo obtener promesa de restauración para sesión ${sessionId}`);
        }
        
      } catch (initError) {
        logger.error(`❌ Error al inicializar restauración de sesión ${sessionId}:`, {
          errorMessage: initError.message,
          stack: initError.stack
        });
        
        // ✅ Agregar promesa rechazada para mantener el tracking
        restorationPromises.push(
          Promise.resolve({ sessionId, success: false, error: initError.message })
        );
      }
    }

    // ✅ Esperar a que todas las promesas se resuelvan (exitosas o fallidas)
    if (restorationPromises.length > 0) {
      logger.info(`⏳ Esperando restauración de ${restorationPromises.length} sesiones...`);
      
      try {
        // ✅ Usar Promise.allSettled para esperar todas las promesas sin fallar si alguna se rechaza
        const results = await Promise.allSettled(restorationPromises);
        
        // ✅ Procesar resultados
        const successful = [];
        const failed = [];
        
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const sessionResult = result.value;
            if (sessionResult.success) {
              successful.push(sessionResult.sessionId);
            } else {
              failed.push({ sessionId: sessionResult.sessionId, error: sessionResult.error });
            }
          } else {
            // Promesa rechazada
            const sessionId = sessionFolders[index]?.name || `unknown-${index}`;
            failed.push({ sessionId, error: result.reason?.message || 'Unknown error' });
          }
        });

        // ✅ Log de resumen final
        logger.info(`🎯 Proceso de restauración completado:`, {
          total: sessionFolders.length,
          successful: successful.length,
          failed: failed.length,
          successfulSessions: successful,
          failedSessions: failed.map(f => `${f.sessionId}: ${f.error}`)
        });

        if (successful.length > 0) {
          logger.info(`✅ Sesiones restauradas exitosamente: ${successful.join(', ')}`);
        }

        if (failed.length > 0) {
          logger.warn(`❌ Sesiones que fallaron al restaurar: ${failed.map(f => f.sessionId).join(', ')}`);
        }

      } catch (globalError) {
        logger.error('🛑 Error global durante la espera de restauración de sesiones:', {
          errorMessage: globalError.message,
          stack: globalError.stack
        });
      }
    }

    // ✅ Programar limpieza de promesas huérfanas cada 5 minutos
    setInterval(() => {
      try {
        whatsappService.cleanupOrphanedPromises();
      } catch (cleanupError) {
        logger.error('Error en limpieza de promesas huérfanas:', {
          errorMessage: cleanupError.message
        });
      }
    }, 5 * 60 * 1000); // 5 minutos

    logger.info('🏁 Proceso de restauración de sesiones finalizado');

  } catch (globalError) {
    logger.error('🛑 Error global al intentar restaurar sesiones:', {
      errorMessage: globalError.message,
      stack: globalError.stack
    });
  }
}

/**
 * ✅ Función auxiliar para obtener el estado de todas las restauraciones en curso
 * Útil para debugging o monitoreo
 */
function getRestorationStatus() {
  try {
    const allPromises = whatsappService.getAllRestorationPromises();
    return {
      activeRestorations: allPromises.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error al obtener estado de restauraciones:', {
      errorMessage: error.message
    });
    return {
      activeRestorations: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * ✅ Función auxiliar para esperar que se complete una sesión específica
 * @param {string} sessionId - ID de la sesión a esperar
 * @param {number} timeoutMs - Timeout en milisegundos (default: 60000)
 * @returns {Promise} - Promesa que se resuelve cuando la sesión está lista
 */
async function waitForSessionReady(sessionId, timeoutMs = 60000) {
  const restorationPromise = whatsappService.getRestorationPromise(sessionId);
  
  if (!restorationPromise) {
    throw new Error(`No hay proceso de restauración activo para la sesión ${sessionId}`);
  }

  try {
    // ✅ Esperar con timeout
    const result = await Promise.race([
      restorationPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout esperando sesión ${sessionId}`)), timeoutMs)
      )
    ]);

    logger.info(`✅ Sesión ${sessionId} confirmada como lista`, { result });
    return result;

  } catch (error) {
    logger.error(`❌ Error esperando sesión ${sessionId}:`, {
      errorMessage: error.message,
      sessionId
    });
    throw error;
  }
}

// ✅ Exportar función principal y utilidades
module.exports = restoreSessionsOnStart;
module.exports.getRestorationStatus = getRestorationStatus;
module.exports.waitForSessionReady = waitForSessionReady;