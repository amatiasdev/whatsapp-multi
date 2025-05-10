const logger = require('../utils/logger');

/**
 * Clase para gestionar información de contactos y grupos
 */
class ContactsManager {
  constructor() {
    this.contactsCache = new Map(); // Caché de información de contactos por número
    this.groupsCache = new Map();   // Caché de información de grupos por ID
    this.cacheExpiryMs = 3600000;   // 1 hora de validez para caché
  }

  /**
   * Obtiene información de un contacto (nombre guardado, etc.)
   * @param {Object} client - Cliente de WhatsApp
   * @param {string} contactId - ID del contacto (número)
   * @returns {Promise<Object>} - Información del contacto
   */
  async getContactInfo(client, contactId) {
    if (!client || !contactId) {
      return null;
    }

    try {
      // Revisar caché primero
      const cachedContact = this.getCachedContact(contactId);
      if (cachedContact) {
        return cachedContact;
      }

      // Obtener contacto mediante la API de whatsapp-web.js
      const contact = await client.getContactById(contactId);
      
      if (!contact) {
        logger.debug(`Contacto no encontrado: ${contactId}`);
        return null;
      }

      // Extraer información relevante
      const contactInfo = {
        id: contact.id._serialized,
        number: contact.number,
        name: contact.name || null,            // Nombre como aparece en su perfil
        pushname: contact.pushname || null,    // Nombre público del contacto
        shortName: contact.shortName || null,  // Nombre corto del contacto
        formattedName: contact.formattedName || contact.number, // Nombre formateado o número
        isMyContact: contact.isMyContact || false, // Si es un contacto guardado
        isWAContact: contact.isWAContact || false, // Si es un contacto de WhatsApp
        profilePictureUrl: null
      };

      // Intentar obtener el nombre guardado (como lo tienes en tu agenda)
      if (contact.isMyContact) {
        // El nombre de contacto generalmente está en formattedName o en name
        contactInfo.savedName = contact.name || contact.formattedName || null;
      }

      // Intentar obtener la foto de perfil (URL)
      try {
        const profilePic = await contact.getProfilePicUrl();
        if (profilePic) {
          contactInfo.profilePictureUrl = profilePic;
        }
      } catch (picError) {
        logger.debug(`No se pudo obtener foto de perfil para ${contactId}: ${picError.message}`);
      }

      // Guardar en caché
      this.cacheContact(contactId, contactInfo);
      
      return contactInfo;
    } catch (error) {
      logger.error(`Error al obtener información de contacto ${contactId}:`, error);
      return {
        id: contactId,
        error: error.message
      };
    }
  }

  /**
   * Obtiene información detallada de un grupo
   * @param {Object} client - Cliente de WhatsApp
   * @param {string} groupId - ID del grupo
   * @returns {Promise<Object>} - Información del grupo
   */
  async getGroupInfo(client, groupId) {
    if (!client || !groupId) {
      return null;
    }

    try {
      // Revisar caché primero
      const cachedGroup = this.getCachedGroup(groupId);
      if (cachedGroup) {
        return cachedGroup;
      }

      // Obtener chat mediante la API de whatsapp-web.js
      const chat = await client.getChatById(groupId);
      
      if (!chat || !chat.isGroup) {
        logger.debug(`Grupo no encontrado o no es un grupo: ${groupId}`);
        return null;
      }

      // Extraer información básica del grupo
      const groupInfo = {
        id: chat.id._serialized,
        name: chat.name || 'Grupo sin nombre',
        isGroup: true,
        participantsCount: chat.participants ? chat.participants.length : 0,
        isReadOnly: chat.isReadOnly || false,
        timestamp: Date.now()
      };

      // Obtener información de participantes
      if (chat.participants && chat.participants.length > 0) {
        const participantsPromises = chat.participants.map(async (participant) => {
          const contactId = participant.id._serialized;
          
          // Obtener nombre del contacto si es posible
          let contactInfo = await this.getContactInfo(client, contactId);
          if (!contactInfo) {
            contactInfo = {
              id: contactId,
              number: contactId.split('@')[0]
            };
          }
          
          return {
            id: contactId,
            number: contactInfo.number,
            savedName: contactInfo.savedName || null,
            pushname: contactInfo.pushname || null,
            isAdmin: participant.isAdmin || false,
            isSuperAdmin: participant.isSuperAdmin || false
          };
        });

        groupInfo.participants = await Promise.all(participantsPromises);
      } else {
        groupInfo.participants = [];
      }

      // Intentar obtener la imagen del grupo
      try {
        const groupPic = await chat.getProfilePicUrl();
        if (groupPic) {
          groupInfo.profilePictureUrl = groupPic;
        }
      } catch (picError) {
        logger.debug(`No se pudo obtener imagen del grupo ${groupId}: ${picError.message}`);
      }

      // Guardar en caché
      this.cacheGroup(groupId, groupInfo);
      
      return groupInfo;
    } catch (error) {
      logger.error(`Error al obtener información del grupo ${groupId}:`, error);
      return {
        id: groupId,
        isGroup: true,
        error: error.message
      };
    }
  }

  /**
   * Guarda un contacto en caché
   * @param {string} contactId - ID del contacto
   * @param {Object} info - Información del contacto
   */
  cacheContact(contactId, info) {
    if (!contactId || !info) return;
    
    info.cachedAt = Date.now();
    this.contactsCache.set(contactId, info);
    logger.debug(`Contacto guardado en caché: ${contactId}`);
  }

  /**
   * Obtiene un contacto de la caché si es válido
   * @param {string} contactId - ID del contacto
   * @returns {Object|null} - Información del contacto o null si no está en caché o expiró
   */
  getCachedContact(contactId) {
    if (!contactId || !this.contactsCache.has(contactId)) {
      return null;
    }
    
    const cachedInfo = this.contactsCache.get(contactId);
    const now = Date.now();
    
    // Verificar si la caché ha expirado
    if (now - cachedInfo.cachedAt > this.cacheExpiryMs) {
      this.contactsCache.delete(contactId);
      return null;
    }
    
    return cachedInfo;
  }

  /**
   * Guarda un grupo en caché
   * @param {string} groupId - ID del grupo
   * @param {Object} info - Información del grupo
   */
  cacheGroup(groupId, info) {
    if (!groupId || !info) return;
    
    info.cachedAt = Date.now();
    this.groupsCache.set(groupId, info);
    logger.debug(`Grupo guardado en caché: ${groupId}`);
  }

  /**
   * Obtiene un grupo de la caché si es válido
   * @param {string} groupId - ID del grupo
   * @returns {Object|null} - Información del grupo o null si no está en caché o expiró
   */
  getCachedGroup(groupId) {
    if (!groupId || !this.groupsCache.has(groupId)) {
      return null;
    }
    
    const cachedInfo = this.groupsCache.get(groupId);
    const now = Date.now();
    
    // Verificar si la caché ha expirado
    if (now - cachedInfo.cachedAt > this.cacheExpiryMs) {
      this.groupsCache.delete(groupId);
      return null;
    }
    
    return cachedInfo;
  }

  /**
   * Limpia la caché de contactos y grupos expirados
   */
  cleanupCache() {
    const now = Date.now();
    
    // Limpiar caché de contactos
    this.contactsCache.forEach((info, id) => {
      if (now - info.cachedAt > this.cacheExpiryMs) {
        this.contactsCache.delete(id);
      }
    });
    
    // Limpiar caché de grupos
    this.groupsCache.forEach((info, id) => {
      if (now - info.cachedAt > this.cacheExpiryMs) {
        this.groupsCache.delete(id);
      }
    });
    
    logger.debug(`Caché limpiada. Contactos: ${this.contactsCache.size}, Grupos: ${this.groupsCache.size}`);
  }
}

module.exports = new ContactsManager();