const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Servicio para comunicación directa con el backend principal
 */
class BackendService {
  constructor() {
    this.initialized = false;
    this.client = null;
    this.stats = {
      totalMessages: 0,
      successfulSends: 0,
      failedSends: 0,
      lastError: null,
      startTime: Date.now()
    };
    
    this.initializeClient();
  }

  /**
   * Inicializa el cliente HTTP para comunicación con backend
   */
  initializeClient() {
    try {
      // Crear instancia de axios con configuración base
      this.client = axios.create({
        baseURL: config.backend.apiUrl,
        timeout: config.backend.timeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': config.backend.userAgent,
          'Accept': 'application/json'
        },
        // Configuración de reintentos
        retries: config.backend.retries,
        retryDelay: config.backend.retryDelay
      });

      // Interceptor para logging de requests
      this.client.interceptors.request.use(
        (config) => {
          logger.debug(`Enviando request al backend: ${config.method?.toUpperCase()} ${config.url}`);
          return config;
        },
        (error) => {
          logger.error('Error en request interceptor:', { errorMessage: error.message });
          return Promise.reject(error);
        }
      );

      // Interceptor para logging de responses
      this.client.interceptors.response.use(
        (response) => {
          logger.debug(`Response del backend: ${response.status} ${response.statusText}`);
          return response;
        },
        (error) => {
          logger.debug(`Error response del backend: ${error.response?.status || 'No status'} ${error.message}`);
          return Promise.reject(error);
        }
      );

      this.initialized = true;
      logger.info('Cliente HTTP para backend inicializado correctamente', {
        baseURL: config.backend.apiUrl,
        timeout: config.backend.timeout,
        userAgent: config.backend.userAgent
      });

    } catch (error) {
      logger.error('Error al inicializar cliente HTTP para backend:', {
        errorMessage: error.message,
        stack: error.stack
      });
      this.initialized = false;
    }
  }

  /**
   * Envía un mensaje individual al backend de forma no bloqueante
   * @param {Object} messageData - Datos completos del mensaje
   * @returns {Promise<boolean>} - true si el envío fue exitoso, false en caso contrario
   */
  async sendMessageToBackend(messageData) {
    if (!this.initialized || !this.client) {
      logger.warn('Cliente HTTP no inicializado, no se puede enviar mensaje');
      this.stats.failedSends++;
      return false;
    }

    const startTime = Date.now();
    this.stats.totalMessages++;

    try {
      // Preparar payload con estructura estándar
      const payload = this.prepareMessagePayload(messageData);
      
      // Log de envío inmediato
      logger.debug(`Enviando mensaje individual al backend`, {
        messageId: messageData.id,
        chatId: messageData.from,
        sessionId: messageData.sessionId,
        hasMedia: messageData.hasMedia || false,
        messageType: messageData.type
      });

      // Realizar request con timeout específico
      const response = await this.client.post(config.backend.messagesEndpoint, payload);

      // Verificar respuesta exitosa
      if (response.status >= 200 && response.status < 300) {
        this.stats.successfulSends++;
        const duration = Date.now() - startTime;
        
        logger.info(`Mensaje enviado exitosamente al backend`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          responseStatus: response.status,
          duration: `${duration}ms`
        });

        // Log estadísticas cada 100 mensajes
        if (this.stats.totalMessages % config.statistics.logEvery === 0) {
          this.logStatistics();
        }

        return true;
      } else {
        throw new Error(`Respuesta inesperada del backend: ${response.status}`);
      }

    } catch (error) {
      this.stats.failedSends++;
      this.stats.lastError = {
        message: error.message,
        timestamp: new Date(),
        messageId: messageData.id
      };

      const duration = Date.now() - startTime;
      
      // Log error pero no fallar
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        logger.warn(`Backend no disponible, mensaje no enviado`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          error: error.code,
          duration: `${duration}ms`
        });
      } else {
        logger.error(`Error al enviar mensaje al backend`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          errorMessage: error.message,
          errorCode: error.code,
          responseStatus: error.response?.status,
          duration: `${duration}ms`
        });
      }

      return false;
    }
  }

  /**
   * Prepara el payload del mensaje con estructura estándar para el backend
   * @param {Object} messageData - Datos del mensaje de WhatsApp
   * @returns {Object} - Payload estructurado para el backend
   */
  prepareMessagePayload(messageData) {
    const payload = {
      // Información de sesión y servicio
      sessionId: messageData.sessionId,
      serviceVersion: config.backend.userAgent,
      timestamp: Date.now(),
      capturedAt: messageData.timestamp,
      
      // Datos principales del mensaje
      message: {
        id: messageData.id,
        from: messageData.from,
        to: messageData.to,
        body: messageData.body || '',
        timestamp: messageData.timestamp,
        type: messageData.type || 'text',
        hasMedia: messageData.hasMedia || false,
        isForwarded: messageData.isForwarded || false,
        isStatus: messageData.isStatus || false,
        deviceType: messageData.deviceType || null
      },

      // Información de chat
      chat: {
        id: messageData.from,
        isGroup: messageData.isGroupMessage || false,
        name: messageData.groupName || messageData.contactName || null
      }
    };

    // Agregar información de contacto si está disponible
    if (messageData.contact) {
      payload.contact = {
        id: messageData.contact.id,
        number: messageData.contact.number,
        name: messageData.contact.name,
        savedName: messageData.contact.savedName,
        pushname: messageData.contact.pushname,
        isMyContact: messageData.contact.isMyContact || false,
        profilePictureUrl: messageData.contact.profilePictureUrl || null
      };
    }

    // Agregar información de grupo si es mensaje grupal
    if (messageData.isGroupMessage && messageData.group) {
      payload.group = {
        id: messageData.group.id,
        name: messageData.group.name,
        participantsCount: messageData.group.participantsCount || 0,
        profilePictureUrl: messageData.group.profilePictureUrl || null
      };

      // Información del autor del mensaje en grupo
      if (messageData.authorContact) {
        payload.author = {
          id: messageData.authorContact.id,
          number: messageData.authorContact.number,
          name: messageData.authorContact.name || messageData.authorName,
          savedName: messageData.authorContact.savedName,
          pushname: messageData.authorContact.pushname
        };
      }
    }

    // Agregar metadata de medios si está disponible
    if (messageData.hasMedia && messageData.media) {
      payload.media = {
        type: messageData.media.mediaType,
        mimeType: messageData.media.mimeType,
        filename: messageData.media.filename,
        filesize: messageData.media.filesize,
        // NO incluir data (base64) por tamaño
        hasData: !!messageData.media.data,
        dataSize: messageData.media.data ? messageData.media.data.length : 0,
        
        // Metadata específica por tipo
        duration: messageData.media.duration || null,
        width: messageData.media.width || null,
        height: messageData.media.height || null,
        isViewOnce: messageData.media.isViewOnce || false
      };

      // Solo incluir data de medios pequeños (< 1MB)
      if (messageData.media.data && messageData.media.data.length < 1048576) {
        payload.media.data = messageData.media.data;
      }
    }

    return payload;
  }

}

module.exports = new BackendService();