const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

// Crear directorio para almacenar temporalmente los medios si no existe
const mediaTempDir = path.join(__dirname, '../../media-temp');
if (!fs.existsSync(mediaTempDir)) {
  fs.mkdirSync(mediaTempDir, { recursive: true });
}

class WhatsAppMediaHandler {
  constructor() {
    this.mediaTempDir = mediaTempDir;
    this.mediaTypes = {
      IMAGE: 'image',
      VIDEO: 'video',
      AUDIO: 'audio',
      VOICE: 'ptt', // Voice note (push-to-talk)
      DOCUMENT: 'document',
      STICKER: 'sticker'
    };
  }

  /**
   * Maneja la descarga y procesamiento de medios de un mensaje
   * @param {Object} message - Mensaje de WhatsApp
   * @returns {Promise<Object>} - Información del medio procesado
   */
  async processMessageMedia(message) {
    if (!message || !message.hasMedia) {
      return null;
    }

    try {
      // Descargar el medio
      logger.info(`Descargando medio del mensaje ${message.id?._serialized}`);
      const mediaData = await this.downloadMedia(message);
      
      // Si no se pudo descargar, retornar null
      if (!mediaData) {
        return null;
      }
      
      // Determinar tipo de medio
      const mediaType = this.getMediaType(message);
      
      // Crear objeto con información del medio
      const mediaInfo = {
        mediaType: mediaType,
        mimeType: mediaData.mimetype || this.getMimeTypeFromMediaType(mediaType),
        data: mediaData.data, // base64 data
        filename: mediaData.filename || this.generateFilename(mediaType, mediaData.mimetype),
        filesize: mediaData.filesize,
      };
      
      // Si hay metadatos adicionales específicos para el tipo de medio, agregarlos
      this.addTypeSpecificMetadata(mediaInfo, message, mediaType);
      
      return mediaInfo;
    } catch (error) {
      logger.error(`Error al procesar medio del mensaje ${message.id?._serialized}:`, error);
      return {
        mediaType: 'error',
        error: error.message
      };
    }
  }

  /**
   * Descarga el medio de un mensaje
   * @param {Object} message - Mensaje de WhatsApp
   * @returns {Promise<Object>} - Datos del medio
   */
  async downloadMedia(message) {
    try {
      // Descargar el medio
      const media = await message.downloadMedia();
      
      if (!media || !media.data) {
        logger.warn(`No se pudo descargar el medio del mensaje ${message.id?._serialized}`);
        return null;
      }
      
      return media;
    } catch (error) {
      logger.error(`Error al descargar medio del mensaje ${message.id?._serialized}:`, error);
      throw error;
    }
  }

  /**
   * Determina el tipo de medio basado en el mensaje
   * @param {Object} message - Mensaje de WhatsApp
   * @returns {string} - Tipo de medio
   */
  getMediaType(message) {
    if (!message) return 'unknown';
    
    if (message.type === 'image') return this.mediaTypes.IMAGE;
    if (message.type === 'video') return this.mediaTypes.VIDEO;
    if (message.type === 'audio') return this.mediaTypes.AUDIO;
    if (message.type === 'ptt') return this.mediaTypes.VOICE;
    if (message.type === 'document') return this.mediaTypes.DOCUMENT;
    if (message.type === 'sticker') return this.mediaTypes.STICKER;
    
    return 'unknown';
  }

  /**
   * Genera un nombre de archivo basado en el tipo de medio y el mimetype
   * @param {string} mediaType - Tipo de medio
   * @param {string} mimeType - Tipo MIME
   * @returns {string} - Nombre de archivo
   */
  generateFilename(mediaType, mimeType) {
    const timestamp = Date.now();
    const extension = this.getExtensionFromMimeType(mimeType);
    
    return `${mediaType}_${timestamp}.${extension}`;
  }

  /**
   * Obtiene la extensión de archivo a partir del tipo MIME
   * @param {string} mimeType - Tipo MIME
   * @returns {string} - Extensión de archivo
   */
  getExtensionFromMimeType(mimeType) {
    if (!mimeType) return 'bin';
    
    // Mapa de tipos MIME a extensiones
    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'application/pdf': 'pdf',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'text/plain': 'txt'
    };
    
    return mimeToExt[mimeType] || 'bin';
  }

  /**
   * Obtiene un tipo MIME predeterminado basado en el tipo de medio
   * @param {string} mediaType - Tipo de medio
   * @returns {string} - Tipo MIME
   */
  getMimeTypeFromMediaType(mediaType) {
    const typeToMime = {
      [this.mediaTypes.IMAGE]: 'image/jpeg',
      [this.mediaTypes.VIDEO]: 'video/mp4',
      [this.mediaTypes.AUDIO]: 'audio/mpeg',
      [this.mediaTypes.VOICE]: 'audio/ogg',
      [this.mediaTypes.DOCUMENT]: 'application/octet-stream',
      [this.mediaTypes.STICKER]: 'image/webp'
    };
    
    return typeToMime[mediaType] || 'application/octet-stream';
  }

  /**
   * Agrega metadatos específicos según el tipo de medio
   * @param {Object} mediaInfo - Objeto de información de medio
   * @param {Object} message - Mensaje de WhatsApp
   * @param {string} mediaType - Tipo de medio
   */
  addTypeSpecificMetadata(mediaInfo, message, mediaType) {
    if (mediaType === this.mediaTypes.IMAGE) {
      // Intentar obtener dimensiones de imagen (no siempre disponible)
      if (message._data && message._data.width && message._data.height) {
        mediaInfo.width = message._data.width;
        mediaInfo.height = message._data.height;
      }
      
      // Verificar si es una imagen que desaparece
      if (message._data && message._data.isViewOnce) {
        mediaInfo.isViewOnce = true;
      }
    } 
    else if (mediaType === this.mediaTypes.VIDEO) {
      // Intentar obtener duración del video
      if (message._data && message._data.duration) {
        mediaInfo.duration = message._data.duration;
      }
      
      // Verificar si es un video que desaparece
      if (message._data && message._data.isViewOnce) {
        mediaInfo.isViewOnce = true;
      }
    } 
    else if (mediaType === this.mediaTypes.AUDIO || mediaType === this.mediaTypes.VOICE) {
      // Intentar obtener duración del audio
      if (message._data && message._data.duration) {
        mediaInfo.duration = message._data.duration;
      }
    } 
    else if (mediaType === this.mediaTypes.DOCUMENT) {
      // Nombre original del documento (si está disponible)
      if (message._data && message._data.filename) {
        mediaInfo.originalFilename = message._data.filename;
      }
    }
  }

  /**
   * Guarda temporalmente un medio en disco
   * @param {Object} mediaInfo - Información del medio
   * @returns {string} - Ruta al archivo guardado
   */
  saveTempMedia(mediaInfo) {
    if (!mediaInfo || !mediaInfo.data) {
      return null;
    }
    
    try {
      const filePath = path.join(this.mediaTempDir, mediaInfo.filename);
      const buffer = Buffer.from(mediaInfo.data, 'base64');
      
      fs.writeFileSync(filePath, buffer);
      logger.debug(`Medio guardado temporalmente en ${filePath}`);
      
      return filePath;
    } catch (error) {
      logger.error('Error al guardar medio temporalmente:', error);
      return null;
    }
  }

  /**
   * Limpia archivos temporales antiguos
   * @param {number} maxAgeMinutes - Edad máxima en minutos
   */
  cleanupTempFiles(maxAgeMinutes = 60) {
    try {
      const files = fs.readdirSync(this.mediaTempDir);
      const now = Date.now();
      
      files.forEach(file => {
        const filePath = path.join(this.mediaTempDir, file);
        const stats = fs.statSync(filePath);
        const fileAgeMinutes = (now - stats.mtimeMs) / (1000 * 60);
        
        if (fileAgeMinutes > maxAgeMinutes) {
          fs.unlinkSync(filePath);
          logger.debug(`Archivo temporal eliminado: ${filePath} (${fileAgeMinutes.toFixed(2)} minutos)`);
        }
      });
    } catch (error) {
      logger.error('Error al limpiar archivos temporales:', error);
    }
  }
}

module.exports = new WhatsAppMediaHandler();