const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Servicio simplificado para comunicación directa con el backend principal
 */
class BackendService {
  constructor() {
    this.initialized = false;
    this.client = null;
    
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
        }
      });

      this.initialized = true;
      logger.info('Cliente HTTP para backend inicializado correctamente', {
        baseURL: config.backend.apiUrl,
        timeout: config.backend.timeout
      });

    } catch (error) {
      logger.error('Error al inicializar cliente HTTP para backend:', {
        errorMessage: error.message
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
      return false;
    }

    try {
      // Preparar payload con estructura estándar
      const payload = this.prepareMessagePayload(messageData);
      
      // Log de envío inmediato
      logger.debug(`Enviando mensaje individual al backend`, {
        messageId: messageData.id,
        chatId: messageData.from,
        sessionId: messageData.sessionId
      });

      // Realizar request con timeout específico
      const response = await this.client.post(config.backend.messagesEndpoint, payload);

      // Verificar respuesta exitosa
      if (response.status >= 200 && response.status < 300) {
        logger.info(`Mensaje enviado exitosamente al backend`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          responseStatus: response.status
        });

        return true;
      } else {
        throw new Error(`Respuesta inesperada del backend: ${response.status}`);
      }

    } catch (error) {
      // Log error pero no fallar
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        logger.warn(`Backend no disponible, mensaje no enviado`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          error: error.code
        });
      } else {
        logger.error(`Error al enviar mensaje al backend`, {
          messageId: messageData.id,
          chatId: messageData.from,
          sessionId: messageData.sessionId,
          errorMessage: error.message,
          errorCode: error.code,
          responseStatus: error.response?.status
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