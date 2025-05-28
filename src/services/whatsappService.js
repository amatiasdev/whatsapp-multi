const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');
const webhookService = require('./webhookService');
const mediaHandler = require('./whatsappMediaHandler');
const contactsManager = require('./contactsManager');
const qrService = require('./qrService');
const chatService = require('./whatsappChatService');
const socketService = require('./socketService');
class WhatsAppService {
  constructor() {
    this.clients = new Map(); // Map de clientId -> { client, isListening, messageBuffer }
    this.ensureSessionDirectory();
    setInterval(() => {
        try {
          contactsManager.cleanupCache();
        } catch (error) {
          logger.error('Error al limpiar caché de contactos:', error);
        }
    }, 7200000); // 2 horas en milisegundos
  }

  ensureSessionDirectory() {
    if (!fs.existsSync(config.sessionDataPath)) {
      fs.mkdirSync(config.sessionDataPath, { recursive: true });
      logger.info(`Directorio de sesiones creado: ${config.sessionDataPath}`);
    }
  }

  async initializeClient(sessionId) {
    if (this.clients.size >= config.maxSessions) {
      throw new Error(`Límite de sesiones alcanzado (${config.maxSessions})`);
    }

    // Verificar si ya existe una sesión con este ID
    if (this.clients.has(sessionId)) {
      logger.info(`La sesión ${sessionId} ya está inicializada`);
      return { 
        status: 'already_initialized',
        clientId: sessionId
      };
    }

    // Crear directorio específico para esta sesión si no existe
    const sessionDir = path.join(config.sessionDataPath, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Crear cliente de WhatsApp
    const client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: sessionId,
        dataPath: config.sessionDataPath
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });

    // Configurar la sesión en nuestro mapa
    this.clients.set(sessionId, {
      client,
      isListening: false,
      messageBuffer: {},  // Objeto donde las claves son chatIds y los valores son arrays de mensajes
      chunkTimers: {}     // Timers para enviar chunks por chatId
    });

    // Manejar la generación de código QR
    client.on('qr', (qr) => {
      logger.info(`Código QR generado para la sesión ${sessionId}`);
      
      // Guardar QR en el servicio (esto también lo emitirá por socket)
      qrService.saveQR(sessionId, qr);
      
      logger.info(`QR Code guardado y disponible para interfaz web`);
    });

    // Manejar conexión exitosa
    client.on('ready', async () => {
      logger.info(`Cliente WhatsApp listo y conectado para la sesión ${sessionId}`);
      
      // Marcar sesión como conectada en el servicio QR
      qrService.markSessionConnected(sessionId);
      
      // NO iniciar escucha automáticamente aquí
      // El backend principal lo hará cuando sea necesario
      logger.info(`Sesión ${sessionId} lista para recibir comandos de escucha`);
    });

    // Manejar desconexión
    client.on('disconnected', (reason) => {
      logger.warn(`Cliente WhatsApp desconectado para la sesión ${sessionId}: ${reason}`);
      
      // Si tienes markSessionDisconnected, úsalo
      if (typeof qrService.markSessionDisconnected === 'function') {
        qrService.markSessionDisconnected(sessionId);
      }
      
      this.cleanupSession(sessionId);
    });

    // Inicializar el cliente
    try {
      await client.initialize();
      logger.info(`Cliente WhatsApp inicializado para la sesión ${sessionId}`);
      return { 
        status: 'initialized',
        clientId: sessionId
      };
    } catch (error) {
      logger.error(`Error al inicializar el cliente WhatsApp para la sesión ${sessionId}:`, error);
      this.cleanupSession(sessionId);
      throw error;
    }
  }

  startListening(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }

    if (session.isListening) {
      logger.info(`La sesión ${sessionId} ya está en modo escucha`);
      return { status: 'already_listening' };
    }

    // Remover listeners anteriores para evitar duplicados
    session.client.removeAllListeners('message');
    
    // Configurar el manejador de mensajes
    session.client.on('message', (message) => this.handleMessage(sessionId, message));
    
    // Marcar como escuchando
    session.isListening = true;
    logger.info(`Modo escucha activado para la sesión ${sessionId}`);
    
    // Emitir estado por socket
    socketService.emitListeningStatus(sessionId, true);
    
    return { status: 'listening_started' };
  }

  stopListening(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }

    if (!session.isListening) {
      logger.info(`La sesión ${sessionId} no está en modo escucha`);
      return { status: 'not_listening' };
    }

    // Remover el manejador de mensajes
    session.client.removeAllListeners('message');
    
    // Enviar los mensajes restantes en el buffer
    this.sendStopListeningCommand(sessionId);
    
    // Limpiar los timers existentes
    Object.keys(session.chunkTimers).forEach(chatId => {
      if (session.chunkTimers[chatId]) {
        clearTimeout(session.chunkTimers[chatId]);
        delete session.chunkTimers[chatId];
      }
    });
    
    // Limpiar el buffer de mensajes
    session.messageBuffer = {};
    
    // Marcar como no escuchando
    session.isListening = false;
    logger.info(`Modo escucha desactivado para la sesión ${sessionId}`);
    
    // Emitir estado por socket
    socketService.emitListeningStatus(sessionId, false);
    
    return { status: 'listening_stopped' };
  }


  async handleMessage(sessionId, message) {
    const session = this.clients.get(sessionId);
    if (!session || !session.isListening) return;

    try {
      // Extraer información relevante del mensaje
      const chatId = message.from;
      const isGroupMessage = chatId.endsWith('@g.us');
      const isBroadcast = chatId === 'status@broadcast' || message.isStatus;
      
      // Verificar configuración de escucha para este chat específico
      // Si existe chatFilters y este chat está marcado como no escuchar, ignorarlo
      if (session.chatFilters && session.chatFilters.has(chatId)) {
        const isListeningToChat = session.chatFilters.get(chatId);
        if (!isListeningToChat) {
          logger.debug(`Ignorando mensaje de ${chatId} en sesión ${sessionId} (configurado para no escuchar este chat)`);
          return;
        }
      }
      
      // Aplicar filtros configurados
      const filters = config.messageFilters;
      
      // Filtro de status@broadcast
      if (isBroadcast && filters.ignoreBroadcast) {
        logger.debug(`Ignorando mensaje de status@broadcast en sesión ${sessionId}`);
        return;
      }
      
      // Filtro de grupos
      if (isGroupMessage && filters.ignoreGroups) {
        logger.debug(`Ignorando mensaje de grupo en sesión ${sessionId} (configurado para ignorar grupos)`);
        return;
      }
      
      // Filtro de no-grupos (chats privados)
      if (!isGroupMessage && filters.ignoreNonGroups) {
        logger.debug(`Ignorando mensaje privado en sesión ${sessionId} (configurado para ignorar chats privados)`);
        return;
      }
      
      // Filtro de grupos permitidos
      if (isGroupMessage && filters.allowedGroups.length > 0 && !filters.allowedGroups.includes(chatId)) {
        logger.debug(`Ignorando mensaje de grupo no permitido ${chatId} en sesión ${sessionId}`);
        return;
      }
      
      // Filtro de contactos permitidos
      const senderInGroup = message.author || chatId;
      const senderToCheck = isGroupMessage ? senderInGroup : chatId;
      
      if (filters.allowedContacts.length > 0 && !filters.allowedContacts.includes(senderToCheck)) {
        logger.debug(`Ignorando mensaje de contacto no permitido ${senderToCheck} en sesión ${sessionId}`);
        return;
      }
      
      // Si llegamos aquí, el mensaje pasó todos los filtros
      logger.debug(`Mensaje de ${isGroupMessage ? 'grupo' : 'chat privado'} aceptado: ${chatId}`);
      
      // Extraer solo los datos necesarios del mensaje para evitar estructuras circulares
      const messageData = {
        id: message.id._serialized,
        from: message.from,
        to: message.to,
        body: message.body,
        timestamp: message.timestamp,
        hasMedia: message.hasMedia,
        type: message.type,
        isForwarded: message.isForwarded,
        isStatus: message.isStatus,
        isGroupMessage,
        sessionId
      };

      // Agregar metadatos adicionales si están disponibles
      if (message.author) messageData.author = message.author;
      if (message.deviceType) messageData.deviceType = message.deviceType;
      
      // Obtener información del contacto (solo para mensajes privados)
      if (!isGroupMessage) {
        try {
          const contactInfo = await contactsManager.getContactInfo(session.client, chatId);
          if (contactInfo) {
            messageData.contact = contactInfo;
            
            // Si tenemos un nombre guardado, lo usamos como identificador principal
            if (contactInfo.savedName) {
              messageData.contactName = contactInfo.savedName;
            } else if (contactInfo.pushname) {
              messageData.contactName = contactInfo.pushname;
            } else {
              messageData.contactName = contactInfo.number || 'Desconocido';
            }
          }
        } catch (contactError) {
          logger.debug(`No se pudo obtener información del contacto: ${contactError.message}`);
        }
      }
      
      // Si es un mensaje de grupo, obtener información detallada
      if (isGroupMessage) {
        try {
          // Obtener información completa del grupo
          const groupInfo = await contactsManager.getGroupInfo(session.client, chatId);
          if (groupInfo) {
            messageData.group = groupInfo;
            messageData.groupName = groupInfo.name || 'Grupo sin nombre';
          }
          
          // Si el mensaje tiene un autor (mensaje en grupo), obtener su información
          if (message.author) {
            const authorInfo = await contactsManager.getContactInfo(session.client, message.author);
            if (authorInfo) {
              messageData.authorContact = authorInfo;
              
              // Usar el nombre guardado del autor si está disponible
              if (authorInfo.savedName) {
                messageData.authorName = authorInfo.savedName;
              } else if (authorInfo.pushname) {
                messageData.authorName = authorInfo.pushname;
              } else {
                messageData.authorName = authorInfo.number || 'Desconocido';
              }
            }
          }
        } catch (groupError) {
          logger.debug(`No se pudo obtener información completa del grupo: ${groupError.message}`);
        }
      }
      
      // Si el mensaje tiene medios, procesarlos
      if (message.hasMedia) {
        logger.info(`Mensaje con medios detectado en chatId ${chatId} de tipo ${message.type}`);
        try {
          const media = await mediaHandler.processMessageMedia(message);
          if (media) {
            messageData.media = media;
            logger.info(`Medio procesado correctamente: ${media.mediaType} (${media.mimeType})`);
          }
        } catch (mediaError) {
          logger.error(`Error al procesar medio del mensaje: ${mediaError.message}`);
          messageData.mediaError = mediaError.message;
        }
      }
      
      // Agregar a buffer por chatId
      if (!session.messageBuffer[chatId]) {
        session.messageBuffer[chatId] = [];
      }
      session.messageBuffer[chatId].push(messageData);
      logger.debug(`Mensaje agregado al buffer para chatId ${chatId} en sesión ${sessionId}`);

      // Si llegamos al tamaño del chunk, enviar inmediatamente
      if (session.messageBuffer[chatId].length >= config.messageChunkSize) {
        this.sendMessageChunk(sessionId, chatId);
      } 
      // Si no, programar un envío diferido si no existe un timer para este chat
      else if (!session.chunkTimers[chatId]) {
        session.chunkTimers[chatId] = setTimeout(() => {
          this.sendMessageChunk(sessionId, chatId);
        }, config.chunkSendIntervalMs);
      }
    } catch (error) {
      logger.error(`Error al procesar mensaje en sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        messageId: message?.id?._serialized || 'unknown',
        chatId: message?.from || 'unknown'
      });
    }
  }

  async sendMessageChunk(sessionId, chatId) {
    const session = this.clients.get(sessionId);
    if (!session) return;

    // Limpiar el timer si existe
    if (session.chunkTimers[chatId]) {
      clearTimeout(session.chunkTimers[chatId]);
      delete session.chunkTimers[chatId];
    }

    // Si no hay mensajes, no hacer nada
    if (!session.messageBuffer[chatId] || session.messageBuffer[chatId].length === 0) {
      return;
    }

    // Capturar los mensajes del buffer y limpiar
    const messages = [...session.messageBuffer[chatId]];
    session.messageBuffer[chatId] = [];

    try {
      // Enviar al webhook
      await webhookService.sendMessagesToN8N({
        sessionId,
        chatId,
        messages,
        count: messages.length,
        timestamp: Date.now()
      });
      logger.info(`Chunk de ${messages.length} mensajes enviado a n8n para chatId ${chatId} en sesión ${sessionId}`);
    } catch (error) {
      // NO pasar el objeto error completo al logger para evitar referencias circulares
      logger.error(`Error al enviar chunk de mensajes a n8n para chatId ${chatId} en sesión ${sessionId}:`, {
        errorMessage: error.message,
        chatId,
        sessionId,
        messageCount: messages.length
      });
      
      // Reintegrar mensajes al buffer en caso de error
      if (!session.messageBuffer[chatId]) {
        session.messageBuffer[chatId] = [];
      }
      session.messageBuffer[chatId] = [...session.messageBuffer[chatId], ...messages];
    }
  }
  
  async checkSessionExists(sessionId) {
    // Verificar si ya existe la sesión en el mapa de clientes
    return this.clients.has(sessionId);
  }

  async initializeAndListen(sessionId) {
    try {
      // Verificar si la sesión existe
      const sessionExists = await this.checkSessionExists(sessionId);
      
      let initResult = { sessionAlreadyExists: sessionExists };
      
      // Solo inicializar si es necesario
      if (!sessionExists) {
        initResult = await this.initializeClient(sessionId);
      }

      return {
        initialization: initResult,
        status: 'initializing'
      };
    } catch (error) {
      logger.error('Error en initializeAndListen:', error);
      throw error;
    }
  }

  sendRemainingMessages(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) return;

    // Enviar todos los mensajes restantes en el buffer para cada chat
    Object.keys(session.messageBuffer).forEach(chatId => {
      if (session.messageBuffer[chatId] && session.messageBuffer[chatId].length > 0) {
        this.sendMessageChunk(sessionId, chatId);
      }
    });
  }

  async cleanupSession(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      logger.warn(`Intentando limpiar sesión inexistente: ${sessionId}`);
      return;
    }

    try {
      // Detener la escucha si está activa
      if (session.isListening) {
        this.stopListening(sessionId);
      }

      // Cerrar cliente
      if (session.client) {
        await session.client.destroy();
      }
      
      // Limpiar caché de chats
      chatService.clearCache(sessionId);
      
      // Marcar sesión como desconectada en sockets
      socketService.markSessionDisconnected(sessionId);
      
    } catch (error) {
      logger.error(`Error al limpiar la sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        stack: error.stack
      });
    } finally {
      // Eliminar del mapa de clientes
      this.clients.delete(sessionId);
      logger.info(`Sesión ${sessionId} eliminada`);
    }
  }

  async getSessionInfo(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      return { 
        exists: false,
        sessionId 
      };
    }

    let clientInfo = null;
    try {
      if (session.client && session.client.info) {
        const info = session.client.info;
        clientInfo = {
          wid: info.wid?.user || null,
          phone: info.wid?._serialized || null,
          pushname: info.pushname || null,
          platform: info.platform || null,
          battery: info.battery || null,
          plugged: info.plugged || false
        };
      }
    } catch (error) {
      logger.debug(`No se pudo obtener info del cliente para sesión ${sessionId}: ${error.message}`);
    }

    const bufferStats = {};
    let totalBufferSize = 0;
    
    Object.keys(session.messageBuffer).forEach(chatId => {
      const size = session.messageBuffer[chatId].length;
      bufferStats[chatId] = size;
      totalBufferSize += size;
    });

    return {
      exists: true,
      sessionId,
      isListening: session.isListening,
      isConnected: session.client?.info ? true : false,
      totalBufferSize,
      bufferStats,
      activeTimers: Object.keys(session.chunkTimers).length,
      clientInfo,
      socketConnections: socketService.getConnectionCount(sessionId),
      chatFiltersCount: session.chatFilters ? session.chatFilters.size : 0
    };
  }

  async getSessionStatus(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      return { exists: false };
    }

    return {
      exists: true,
      isListening: session.isListening,
      isConnected: session.client?.info ? true : false,
      bufferSize: Object.keys(session.messageBuffer).reduce(
        (total, chatId) => total + session.messageBuffer[chatId].length, 0
      )
    };
  }

  async getAllSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.clients.entries()) {
      sessions.push({
        sessionId,
        isListening: session.isListening,
        isConnected: session.client?.info ? true : false,
        bufferSize: Object.keys(session.messageBuffer).reduce(
          (total, chatId) => total + session.messageBuffer[chatId].length, 0
        )
      });
    }
    return sessions;
  }

    /**
   * Obtiene la lista de chats para una sesión específica
   * @param {string} sessionId - ID de la sesión
   * @param {boolean} forceRefresh - Si debe forzar actualización
   * @param {number} limit - Límite de chats a devolver (default: 50)
   * @param {number} offset - Offset para paginación (default: 0)
   * @returns {Object} Lista de chats con información básica
   */
  async getSessionChats(sessionId, forceRefresh = false, limit = 50, offset = 0) {
    try {
      logger.info(`Obteniendo chats para sesión ${sessionId} (limit: ${limit}, offset: ${offset}, refresh: ${forceRefresh})`);
      
      // Verificar que la sesión existe
      const session = this.clients.get(sessionId);
      if (!session || !session.client) {
        throw new Error(`Sesión ${sessionId} no encontrada o no inicializada`);
      }

      const client = session.client;
      
      // Verificar que el cliente esté conectado
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        throw new Error(`Cliente WhatsApp no está conectado. Estado actual: ${state}`);
      }

      // Obtener todos los chats
      const allChats = await client.getChats();
      const totalChats = allChats.length;
      
      logger.info(`Total de chats encontrados: ${totalChats} para sesión ${sessionId}`);
      
      // Aplicar paginación
      const paginatedChats = allChats
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
      
      // Formatear la información de cada chat
      const chatList = await Promise.all(
        paginatedChats.map(async (chat, index) => {
          try {
            // Log de progreso cada 10 chats
            if (index % 10 === 0) {
              logger.debug(`Procesando chat ${index + 1}/${paginatedChats.length} para sesión ${sessionId}`);
            }

            // Obtener información básica del chat
            const contact = await chat.getContact();
            const lastMessage = chat.lastMessage;
            
            // Formatear información del chat
            const chatInfo = {
              id: chat.id._serialized,
              name: chat.name || contact.name || contact.pushname || chat.id.user || 'Sin nombre',
              isGroup: chat.isGroup,
              isMuted: chat.isMuted || false,
              unreadCount: chat.unreadCount || 0,
              timestamp: chat.timestamp || Date.now(),
              // Información del último mensaje
              lastMessage: lastMessage ? {
                body: lastMessage.body || '[Media]',
                timestamp: lastMessage.timestamp,
                fromMe: lastMessage.fromMe,
                type: lastMessage.type || 'text'
              } : null,
              // Información del contacto/grupo
              contact: {
                id: contact.id._serialized,
                name: contact.name || contact.pushname || 'Sin nombre',
                shortName: contact.shortName || null,
                isMyContact: contact.isMyContact || false,
                isBlocked: contact.isBlocked || false,
                profilePic: null // Se obtiene después si es necesario
              }
            };

            // Intentar obtener la foto de perfil (puede fallar, no es crítico)
            if (!forceRefresh) {
              // Solo obtener foto si no es refresh para evitar timeouts
              try {
                const profilePicUrl = await Promise.race([
                  contact.getProfilePicUrl(),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout foto perfil')), 3000)
                  )
                ]);
                chatInfo.contact.profilePic = profilePicUrl;
              } catch (picError) {
                // No hacer nada, la foto queda como null
              }
            }

            // Si es un grupo, obtener información adicional
            if (chat.isGroup) {
              try {
                chatInfo.groupInfo = {
                  description: chat.groupMetadata?.desc || '',
                  participantsCount: chat.groupMetadata?.participants?.length || 0,
                  owner: chat.groupMetadata?.owner?._serialized || null
                };
              } catch (groupError) {
                logger.debug(`Error obteniendo info del grupo ${chat.id._serialized}: ${groupError.message}`);
              }
            }

            return chatInfo;
            
          } catch (chatError) {
            logger.warn(`Error procesando chat ${chat.id._serialized}: ${chatError.message}`);
            // Devolver información básica en caso de error
            return {
              id: chat.id._serialized,
              name: chat.name || chat.id.user || 'Chat con error',
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              timestamp: chat.timestamp || Date.now(),
              error: 'Error obteniendo detalles del chat',
              lastMessage: null,
              contact: {
                id: chat.id._serialized,
                name: 'Error al cargar contacto',
                profilePic: null
              }
            };
          }
        })
      );

      const result = {
        success: true,
        sessionId,
        chats: chatList,
        pagination: {
          total: totalChats,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: (parseInt(offset) + parseInt(limit)) < totalChats,
          returned: chatList.length
        },
        timestamp: Date.now()
      };

      logger.info(`Devolviendo ${chatList.length} chats de ${totalChats} totales para sesión ${sessionId}`);
      
      return result;

    } catch (error) {
      logger.error(`Error obteniendo chats para sesión ${sessionId}:`, {
        errorMessage: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Obtiene chats básicos (versión rápida sin fotos de perfil)
   * @param {string} sessionId - ID de la sesión
   * @param {number} limit - Límite de chats
   * @param {number} offset - Offset para paginación
   * @returns {Object} Lista básica de chats
   */
  async getBasicSessionChats(sessionId, limit = 20, offset = 0) {
    try {
      logger.info(`Obteniendo chats básicos para sesión ${sessionId} (limit: ${limit}, offset: ${offset})`);
      
      const session = this.clients.get(sessionId);
      if (!session || !session.client) {
        throw new Error(`Sesión ${sessionId} no encontrada`);
      }

      const client = session.client;
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        throw new Error(`Cliente no conectado. Estado: ${state}`);
      }

      const allChats = await client.getChats();
      const totalChats = allChats.length;
      
      const basicChats = allChats
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
        .map((chat, index) => {
          try {
            return {
              id: chat.id._serialized,
              name: chat.name || chat.id.user || 'Sin nombre',
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              timestamp: chat.timestamp || Date.now(),
              lastMessagePreview: chat.lastMessage?.body?.substring(0, 50) || '',
              isMuted: chat.isMuted || false
            };
          } catch (error) {
            logger.warn(`Error procesando chat básico ${index}: ${error.message}`);
            return {
              id: `error-${index}`,
              name: 'Error al cargar chat',
              isGroup: false,
              unreadCount: 0,
              timestamp: Date.now(),
              lastMessagePreview: '',
              error: true
            };
          }
        });

      return {
        success: true,
        sessionId,
        chats: basicChats,
        total: totalChats,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: (parseInt(offset) + parseInt(limit)) < totalChats
        },
        timestamp: Date.now()
      };

    } catch (error) {
      logger.error(`Error obteniendo chats básicos para sesión ${sessionId}:`, {
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Actualiza el estado de escucha de un chat específico
   * @param {string} sessionId - ID de la sesión
   * @param {string} chatId - ID del chat
   * @param {boolean} isListening - Si el chat debe ser escuchado o no
   * @returns {Promise<Object>} - Objeto con el resultado de la operación
   */
  async updateChatListeningStatus(sessionId, chatId, isListening) {
    const session = this.clients.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }

    // Validar que chatId es válido
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('chatId inválido');
    }

    // Validar que isListening es boolean
    if (typeof isListening !== 'boolean') {
      throw new Error('isListening debe ser un valor booleano');
    }

    try {
      // Inicializar filtros de chat si no existen
      if (!session.chatFilters) {
        session.chatFilters = new Map();
      }
      
      // Actualizar estado en memoria
      session.chatFilters.set(chatId, isListening);
      
      // Actualizar estado en el servicio de chats
      await chatService.updateChatListeningStatus(sessionId, chatId, isListening);
      
      logger.info(`Chat ${chatId} ahora está ${isListening ? 'escuchando' : 'ignorando'} en sesión ${sessionId}`);
      
      return {
        status: 'success',
        chatId,
        isListening
      };
    } catch (error) {
      logger.error(`Error al actualizar estado de escucha para chat ${chatId} en sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        chatId,
        isListening
      });
      throw error;
    }
  }
    // ===== NUEVO MÉTODO 1 =====
  async sendStopListeningCommand(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      logger.warn(`No se puede enviar comando de resumen: sesión ${sessionId} no encontrada`);
      return;
    }

    try {
      // Obtener todos los chats que tienen mensajes en buffer
      const chatsWithMessages = Object.keys(session.messageBuffer).filter(
        chatId => session.messageBuffer[chatId] && session.messageBuffer[chatId].length > 0
      );

      logger.info(`Enviando comando de resumen para ${chatsWithMessages.length} chats en sesión ${sessionId}`);

      // Enviar comando de resumen para cada chat que tiene mensajes
      for (const chatId of chatsWithMessages) {
        await this.sendSummaryCommandForChat(sessionId, chatId);
      }

    } catch (error) {
      logger.error(`Error enviando comandos de resumen para sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId
      });
    }
  }

  // ===== NUEVO MÉTODO 2 =====
  async sendSummaryCommandForChat(sessionId, chatId) {
    const session = this.clients.get(sessionId);
    if (!session || !session.messageBuffer[chatId]) {
      return;
    }

    try {
      // Obtener el último mensaje del buffer para extraer info del chat
      const lastMessage = session.messageBuffer[chatId][session.messageBuffer[chatId].length - 1];
      
      // Crear mensaje de comando sintético
      const commandMessage = {
        id: `stop_command_${Date.now()}`,
        from: chatId,
        to: session.client.info?.wid?._serialized || 'unknown',
        body: 'GIVE_ME_SUMMARY_N8N',
        timestamp: Math.floor(Date.now() / 1000), // En segundos
        hasMedia: false,
        type: 'chat',
        isForwarded: false,
        isStatus: false,
        isGroupMessage: lastMessage?.isGroupMessage || false,
        sessionId: sessionId,
        // Copiar información de contacto/grupo del último mensaje
        contact: lastMessage?.contact || null,
        group: lastMessage?.group || null,
        contactName: lastMessage?.contactName || 'Sistema',
        authorName: lastMessage?.authorName || null,
        authorContact: lastMessage?.authorContact || null
      };

      // Agregar el comando al buffer
      session.messageBuffer[chatId].push(commandMessage);
      
      // Enviar el chunk inmediatamente (esto incluirá el comando)
      await this.sendMessageChunk(sessionId, chatId);
      
      logger.info(`Comando de resumen enviado para chat ${chatId} en sesión ${sessionId}`);
      
    } catch (error) {
      logger.error(`Error enviando comando de resumen para chat ${chatId}:`, {
        errorMessage: error.message,
        sessionId,
        chatId
      });
    }
  }
}

module.exports = new WhatsAppService();