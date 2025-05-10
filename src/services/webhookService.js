const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class WebhookService {
  constructor() {
    this.webhookUrl = config.n8nWebhookUrl;
  }

  // Función para sanitizar objetos antes de convertirlos a JSON
  sanitizeForJson(obj) {
    // Si no es un objeto o es null, devolvemos tal cual
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    // Si es un array, mapeamos cada elemento
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeForJson(item));
    }

    // Si es un objeto, creamos una copia limpia
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      // Saltamos propiedades que pueden causar circularidad
      if (
        key === 'client' || 
        key === '_events' || 
        key === '_eventsCount' || 
        key === '_maxListeners' ||
        key === 'rawData' ||
        key === 'data' && typeof value === 'object' && value !== null && value.buffer
      ) {
        continue;
      }
      
      // Recursivamente sanitizamos el valor
      sanitized[key] = this.sanitizeForJson(value);
    }
    
    return sanitized;
  }

  async sendMessagesToN8N(payload) {
    try {
      // Sanitizar el payload para evitar estructuras circulares
      const sanitizedPayload = this.sanitizeForJson(payload);
      
      logger.info(`Enviando ${sanitizedPayload.messages?.length || 0} mensajes al webhook de n8n para chatId ${sanitizedPayload.chatId}`);

      const response = await axios.post(this.webhookUrl, sanitizedPayload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 segundos de timeout
      });

      if (response.status >= 200 && response.status < 300) {
        logger.info(`Webhook enviado exitosamente a n8n: ${sanitizedPayload.messages?.length || 0} mensajes`);
        return true;
      } else {
        logger.warn(`Respuesta inesperada del webhook n8n: ${response.status} ${response.statusText}`);
        throw new Error(`Error en respuesta del webhook: ${response.status}`);
      }
    } catch (error) {
      // Evitar errores circulares en el logging
      const errorMessage = error.message || 'Error desconocido';
      logger.error(`Error al enviar mensajes al webhook de n8n: ${errorMessage}`);
      throw new Error(`Error al enviar mensajes: ${errorMessage}`);
    }
  }
}

module.exports = new WebhookService();