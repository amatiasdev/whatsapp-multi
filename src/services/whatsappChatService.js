const logger = require('../utils/logger');
const contactsManager = require('./contactsManager');

class WhatsAppChatService {
  constructor() {
    this.cache = new Map(); // sessionId -> { chats, lastUpdate }
    this.MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutos
  }

  /**
   * Obtiene la lista de chats para una sesión específica
   * @param {string} sessionId - ID de la sesión
   * @param {Object} client - Cliente de WhatsApp
   * @param {boolean} forceRefresh - Si true, ignora la caché y obtiene los datos actualizados
   * @returns {Promise<Array>} - Lista de chats ordenados por fecha de último mensaje
   */
  async getChats(sessionId, client, forceRefresh = false) {
    // Verificar si tenemos datos en caché y son recientes
    const now = Date.now();
    const cachedData = this.cache.get(sessionId);
    
    if (!forceRefresh && cachedData && (now - cachedData.lastUpdate < this.MAX_CACHE_AGE_MS)) {
      logger.debug(`Usando datos en caché para lista de chats de sesión ${sessionId}`);
      return cachedData.chats;
    }

    try {
      logger.info(`Obteniendo lista de chats para sesión ${sessionId}`);
      
      // Obtener todos los chats desde WhatsApp API
      const whatsappChats = await client.getChats();
      
      // Transformar a un formato más limpio y con la información necesaria
      const chats = await Promise.all(whatsappChats.map(async (chat) => {
        const isGroup = chat.isGroup;
        let chatInfo = {
          id: chat.id._serialized,
          name: chat.name || 'Chat sin nombre',
          isGroup,
          timestamp: chat.timestamp || 0,
          unreadCount: chat.unreadCount || 0,
          lastMessage: chat.lastMessage ? {
            body: chat.lastMessage.body || '',
            timestamp: chat.lastMessage.timestamp || 0
          } : null,
          isListening: true // Por defecto, todos los chats se escuchan
        };

        // Obtener información adicional según el tipo de chat
        if (isGroup) {
          try {
            // Para grupos, obtener información detallada
            const groupInfo = await contactsManager.getGroupInfo(client, chat.id._serialized);
            if (groupInfo) {
              chatInfo.name = groupInfo.name || chatInfo.name;
              chatInfo.description = groupInfo.description;
              chatInfo.participants = groupInfo.participants?.length || 0;
              chatInfo.picture = groupInfo.picture || null;
            }
          } catch (error) {
            logger.debug(`No se pudo obtener información adicional del grupo ${chat.id._serialized}: ${error.message}`);
          }
        } else {
          try {
            // Para chats individuales, obtener info del contacto
            const contactInfo = await contactsManager.getContactInfo(client, chat.id._serialized);
            if (contactInfo) {
              chatInfo.name = contactInfo.savedName || contactInfo.pushname || contactInfo.number || chatInfo.name;
              chatInfo.number = contactInfo.number;
              chatInfo.picture = contactInfo.picture || null;
            }
          } catch (error) {
            logger.debug(`No se pudo obtener información del contacto ${chat.id._serialized}: ${error.message}`);
          }
        }

        return chatInfo;
      }));

      // Ordenar por timestamp (más reciente primero)
      const sortedChats = chats.sort((a, b) => {
        const aTime = a.timestamp || (a.lastMessage?.timestamp || 0);
        const bTime = b.timestamp || (b.lastMessage?.timestamp || 0);
        return bTime - aTime; // Orden descendente
      });

      // Guardar en caché
      this.cache.set(sessionId, {
        chats: sortedChats,
        lastUpdate: now
      });

      logger.info(`Se obtuvieron ${sortedChats.length} chats para la sesión ${sessionId}`);
      return sortedChats;
    } catch (error) {
      logger.error(`Error al obtener chats para sesión ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Actualiza el estado de escucha de un chat específico
   * @param {string} sessionId - ID de la sesión
   * @param {string} chatId - ID del chat
   * @param {boolean} isListening - Si el chat debe ser escuchado o no
   * @returns {Promise<boolean>} - true si se actualizó correctamente
   */
  async updateChatListeningStatus(sessionId, chatId, isListening) {
    const cachedData = this.cache.get(sessionId);
    if (!cachedData) {
      throw new Error(`No hay datos en caché para la sesión ${sessionId}`);
    }

    const chatIndex = cachedData.chats.findIndex(chat => chat.id === chatId);
    if (chatIndex === -1) {
      throw new Error(`Chat ${chatId} no encontrado en la sesión ${sessionId}`);
    }

    // Actualizar estado
    cachedData.chats[chatIndex].isListening = isListening;
    logger.info(`Estado de escucha actualizado para chat ${chatId} en sesión ${sessionId}: ${isListening}`);
    
    return true;
  }

  /**
   * Limpia la caché para una sesión específica
   * @param {string} sessionId - ID de la sesión
   */
  clearCache(sessionId) {
    if (this.cache.has(sessionId)) {
      this.cache.delete(sessionId);
      logger.debug(`Caché de chats limpiada para sesión ${sessionId}`);
    }
  }

  /**
   * Limpia toda la caché de chats
   */
  clearAllCache() {
    this.cache.clear();
    logger.debug('Caché de chats limpiada completamente');
  }
}

module.exports = new WhatsAppChatService();