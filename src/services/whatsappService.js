const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');
const mediaHandler = require('./whatsappMediaHandler');
const contactsManager = require('./contactsManager');
const qrService = require('./qrService');
const chatService = require('./whatsappChatService');
const socketService = require('./socketService');
const backendService = require('./backendService');

class WhatsAppService {
  constructor() {
    this.clients = new Map(); // Map de clientId -> { client, isListening, lastActivity, etc }
    this.restorationPromises = {};
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

 async validateSessionCreation(sessionId) {
  // Verificar límite global
  if (this.clients.size >= config.maxSessions) {
    return {
      allowed: false,
      reason: 'system_limit_reached',
      maxSessions: config.maxSessions,
      currentSessions: this.clients.size
    };
  }
  
  // Usar la validación del config para sessionId
  const sessionIdValidation = config.validateSessionId(sessionId);
  if (!sessionIdValidation.valid) {
    return {
      allowed: false,
      reason: sessionIdValidation.reason
    };
  }
  
  return {
    allowed: true,
    currentSessions: this.clients.size,
    maxSessions: config.maxSessions
  };
  }

  async initializeClient(sessionId, options = {}) {
    const { fromDisk = false } = options;

    // Validar límites antes de crear
    const validation = await this.validateSessionCreation(sessionId);
    if (!validation.allowed) {
      throw new Error(`No se puede crear sesión: ${validation.reason}. ${validation.maxSessions ? `Límite: ${validation.maxSessions}` : ''}`);
    }

    // ✅ Si es restauración desde disco, crear promesa antes de continuar
    if (fromDisk) {
      this.restorationPromises[sessionId] = {};
      this.restorationPromises[sessionId].promise = new Promise((resolve, reject) => {
        this.restorationPromises[sessionId].resolve = resolve;
        this.restorationPromises[sessionId].reject = reject;
      });
      this.restorationPromises[sessionId].createdAt = Date.now();
      
      logger.debug(`🔄 Promesa de restauración creada para sesión ${sessionId}`);
    }

    // Verificar si ya existe una sesión con este ID
    if (this.clients.has(sessionId)) {
      if (fromDisk) {
        logger.info(`📦 Sesión ${sessionId} restaurada desde disco. Se evita reinicialización.`);
        return { status: 'restored_from_disk', clientId: sessionId };
      }
      const existingSession = this.clients.get(sessionId);
      
      // Si ya tiene cliente y está conectado, retornar información
      if (existingSession.client) {
        try {
          const state = await existingSession.client.getState();
          if (state === 'CONNECTED') {
            logger.info(`La sesión ${sessionId} ya está inicializada y conectada`);
            this.updateSessionActivity(sessionId);
            return { 
              status: 'already_connected',
              clientId: sessionId,
              state: state
            };
          }
        } catch (error) {
          logger.warn(`Error al verificar estado de sesión existente ${sessionId}: ${error.message}`);
        }
      }
      
      logger.info(`Reinicializando sesión existente ${sessionId}`);
      // Limpiar cliente anterior si existe
      if (existingSession.client) {
        try {
          await this.destroyClient(sessionId);
        } catch (error) {
          logger.warn(`Error al limpiar cliente anterior ${sessionId}: ${error.message}`);
        }
      }
    } else {
      // ✅ NUEVA ESTRUCTURA: Eliminamos messageBuffer, chunkTimers
      this.clients.set(sessionId, {
        client: null,
        isListening: false,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        reconnectionAttempts: 0,
        isConnected: false,
        readyAt: null
      });
    }

    // Crear cliente de WhatsApp con configuración mejorada
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
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection'
        ],
        timeout: config.clientTimeout || 45000
      }
    });

    // Actualizar referencia del cliente en la sesión
    const session = this.clients.get(sessionId);
    session.client = client;
    session.lastActivity = Date.now();

    // Manejar la generación de código QR
    client.on('qr', (qr) => {
      logger.info(`Código QR generado para la sesión ${sessionId}`);
      session.lastActivity = Date.now();
      
      // Guardar QR en el servicio
      qrService.saveQR(sessionId, qr);
      
      logger.info(`QR Code guardado y disponible para interfaz web`);
    });

    // Manejar eventos de autenticación
    client.on('authenticated', () => {
      logger.info(`Cliente autenticado para sesión ${sessionId}`);
      session.lastActivity = Date.now();
      session.reconnectionAttempts = 0;
    });

    // ✅ Manejar conexión exitosa con resolución de promesa
    client.on('ready', async () => {
      logger.info(`Cliente WhatsApp listo y conectado para la sesión ${sessionId}`);

      const session = this.clients.get(sessionId);
      if (session) {
        session.isConnected = true;
        session.readyAt = new Date();
      }

      session.lastActivity = Date.now();
      session.reconnectionAttempts = 0;
      
      // Marcar sesión como conectada en el servicio QR
      qrService.markSessionConnected(sessionId);
      
      // Emitir evento de conexión exitosa
      socketService.markSessionConnected(sessionId);
      
      // ✅ Resolver promesa de restauración si existe
      if (this.restorationPromises[sessionId]) {
        logger.debug(`✅ Resolviendo promesa de restauración para sesión ${sessionId}`);
        this.restorationPromises[sessionId].resolve({
          sessionId,
          status: 'ready',
          readyAt: new Date()
        });
        
        delete this.restorationPromises[sessionId];
      }
      
      logger.info(`Sesión ${sessionId} lista para recibir comandos`);
    });

    // Manejar cambios de estado
    client.on('change_state', (state) => {
      logger.debug(`Cambio de estado para sesión ${sessionId}: ${state}`);
      session.lastActivity = Date.now();
      
      socketService.emitSessionStatus(sessionId, 'state_change', { state });
    });

    // ✅ Manejar errores de autenticación con manejo de promesas
    client.on('auth_failure', (message) => {
      logger.error(`Fallo de autenticación en sesión ${sessionId}: ${message}`);
      session.reconnectionAttempts = (session.reconnectionAttempts || 0) + 1;
      
      if (this.restorationPromises[sessionId]) {
        logger.debug(`❌ Rechazando promesa de restauración para sesión ${sessionId} (auth_failure)`);
        this.restorationPromises[sessionId].reject(new Error(`Auth failure: ${message}`));
        delete this.restorationPromises[sessionId];
      }
      
      socketService.emitSessionStatus(sessionId, 'auth_failure', { 
        message,
        attempts: session.reconnectionAttempts 
      });
    });

    // ✅ Manejar desconexión con lógica mejorada y limpieza de promesas
    client.on('disconnected', (reason) => {
      logger.warn(`Cliente WhatsApp desconectado para la sesión ${sessionId}: ${reason}`);
      
      session.lastActivity = Date.now();
      session.lastDisconnectionReason = reason;
      session.isConnected = false;
      
      if (this.restorationPromises[sessionId]) {
        logger.debug(`❌ Rechazando promesa de restauración para sesión ${sessionId} (disconnected: ${reason})`);
        this.restorationPromises[sessionId].reject(new Error(`Disconnected during restoration: ${reason}`));
        delete this.restorationPromises[sessionId];
      }
      
      if (typeof qrService.markSessionDisconnected === 'function') {
        qrService.markSessionDisconnected(sessionId);
      }
      socketService.markSessionDisconnected(sessionId);
      
      this.handleAutomaticReconnection(sessionId, reason);
    });

    // ✅ Manejar errores del cliente con limpieza de promesas
    client.on('error', (error) => {
      logger.error(`Error en cliente WhatsApp para sesión ${sessionId}:`, {
        errorMessage: error.message,
        stack: error.stack
      });
      
      session.lastActivity = Date.now();
      
      if (this.restorationPromises[sessionId]) {
        logger.debug(`❌ Rechazando promesa de restauración para sesión ${sessionId} (client error)`);
        this.restorationPromises[sessionId].reject(error);
        delete this.restorationPromises[sessionId];
      }
      
      socketService.emitSessionStatus(sessionId, 'client_error', { 
        error: error.message 
      });
    });

    // Inicializar el cliente con timeout y retry
    try {
      logger.info(`Inicializando cliente WhatsApp para la sesión ${sessionId}`);
      
      await Promise.race([
        client.initialize(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout en inicialización')), config.clientTimeout || 45000)
        )
      ]);
      
      logger.info(`Cliente WhatsApp inicializado correctamente para la sesión ${sessionId}`);
      
      return { 
        status: 'initialized',
        clientId: sessionId,
        message: 'Cliente inicializado, esperando QR o conexión automática'
      };
      
    } catch (error) {
      logger.error(`Error al inicializar el cliente WhatsApp para la sesión ${sessionId}:`, {
        errorMessage: error.message,
        stack: error.stack
      });
      
      if (this.restorationPromises[sessionId]) {
        logger.debug(`❌ Rechazando promesa de restauración para sesión ${sessionId} (init error)`);
        this.restorationPromises[sessionId].reject(error);
        delete this.restorationPromises[sessionId];
      }
      
      this.cleanupSession(sessionId);
      
      if (error.message.includes('Timeout')) {
        throw new Error(`Timeout al inicializar la sesión. Intente nuevamente.`);
      } else if (error.message.includes('Target closed')) {
        throw new Error(`Error de navegador. El servicio puede estar sobrecargado.`);
      } else {
        throw new Error(`Error al inicializar: ${error.message}`);
      }
    }
  }

  // ✅ Métodos de restauración (mantenidos sin cambios)
  getRestorationPromise(sessionId) {
    return this.restorationPromises[sessionId]?.promise || null;
  }

  isRestoring(sessionId) {
    return !!this.restorationPromises[sessionId];
  }

  getAllRestorationPromises() {
    const promises = Object.keys(this.restorationPromises).map(sessionId => 
      this.restorationPromises[sessionId].promise
    );
    return promises;
  }

  cleanupOrphanedPromises() {
    const now = Date.now();
    const maxWaitTime = 5 * 60 * 1000; // 5 minutos
    
    let cleanedCount = 0;
    
    Object.keys(this.restorationPromises).forEach(sessionId => {
      const promiseData = this.restorationPromises[sessionId];
      if (promiseData.createdAt && (now - promiseData.createdAt) > maxWaitTime) {
        logger.warn(`🧹 Limpiando promesa huérfana para sesión ${sessionId} (${Math.round((now - promiseData.createdAt) / 1000)}s)`);
        promiseData.reject(new Error('Timeout waiting for restoration'));
        delete this.restorationPromises[sessionId];
        cleanedCount++;
      }
    });
    
    if (cleanedCount > 0) {
      logger.info(`🧹 Limpiadas ${cleanedCount} promesas huérfanas de restauración`);
    }
  }

  // ✅ MÉTODO ACTUALIZADO: startListening sin buffers
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
    
    // ✅ CONFIGURAR NUEVO MANEJADOR: handleMessage actualizado
    session.client.on('message', (message) => this.handleMessage(sessionId, message));
    
    // Marcar como escuchando
    session.isListening = true;
    logger.info(`Modo escucha activado para la sesión ${sessionId}`);
    
    // Emitir estado por socket
    socketService.emitListeningStatus(sessionId, true);
    
    return { status: 'listening_started' };
  }

  // ✅ MÉTODO ACTUALIZADO: stopListening sin buffers
  async stopListening(sessionId) {
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
      // Log inmediato de recepción
      logger.debug(`Mensaje recibido en sesión ${sessionId}`, {
        chatId: message.from,
        messageId: message.id._serialized,
        type: message.type,
        hasMedia: message.hasMedia
      });

      // Extraer información relevante del mensaje
      const chatId = message.from;
      const isGroupMessage = chatId.endsWith('@g.us');
      const isBroadcast = chatId === 'status@broadcast' || message.isStatus;
      
      // Aplicar filtros configurados (mantener lógica existente)
      const filters = config.messageFilters;
      
      if (isBroadcast && filters.ignoreBroadcast) {
        logger.debug(`Ignorando mensaje de status@broadcast en sesión ${sessionId}`);
        return;
      }
      
      if (isGroupMessage && filters.ignoreGroups) {
        logger.debug(`Ignorando mensaje de grupo en sesión ${sessionId}`);
        return;
      }
      
      if (!isGroupMessage && filters.ignoreNonGroups) {
        logger.debug(`Ignorando mensaje privado en sesión ${sessionId}`);
        return;
      }
      
      if (isGroupMessage && filters.allowedGroups.length > 0 && !filters.allowedGroups.includes(chatId)) {
        logger.debug(`Ignorando mensaje de grupo no permitido ${chatId} en sesión ${sessionId}`);
        return;
      }
      
      const senderInGroup = message.author || chatId;
      const senderToCheck = isGroupMessage ? senderInGroup : chatId;
      
      if (filters.allowedContacts.length > 0 && !filters.allowedContacts.includes(senderToCheck)) {
        logger.debug(`Ignorando mensaje de contacto no permitido ${senderToCheck} en sesión ${sessionId}`);
        return;
      }
      
      // Extraer datos del mensaje
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
            messageData.contactName = contactInfo.savedName || contactInfo.pushname || contactInfo.number || 'Desconocido';
          }
        } catch (contactError) {
          logger.debug(`No se pudo obtener información del contacto: ${contactError.message}`);
        }
      }
      
      // Si es un mensaje de grupo, obtener información detallada
      if (isGroupMessage) {
        try {
          const groupInfo = await contactsManager.getGroupInfo(session.client, chatId);
          if (groupInfo) {
            messageData.group = groupInfo;
            messageData.groupName = groupInfo.name || 'Grupo sin nombre';
          }
          
          if (message.author) {
            const authorInfo = await contactsManager.getContactInfo(session.client, message.author);
            if (authorInfo) {
              messageData.authorContact = authorInfo;
              messageData.authorName = authorInfo.savedName || authorInfo.pushname || authorInfo.number || 'Desconocido';
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
      
      // ✅ ENVÍO INDIVIDUAL NO BLOQUEANTE AL BACKEND
      setImmediate(async () => {
        try {
          const success = await backendService.sendMessageToBackend(messageData);
          if (success) {
            logger.info(`Mensaje enviado al backend correctamente`, {
              messageId: messageData.id,
              chatId: messageData.from,
              sessionId
            });
          } else {
            logger.warn(`No se pudo enviar mensaje al backend`, {
              messageId: messageData.id,
              chatId: messageData.from,
              sessionId
            });
          }
        } catch (error) {
          logger.error(`Error enviando mensaje al backend`, {
            messageId: messageData.id,
            chatId: messageData.from,
            sessionId,
            errorMessage: error.message
          });
        }
      });

    } catch (error) {
      logger.error(`Error al procesar mensaje en sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        messageId: message?.id?._serialized || 'unknown',
        chatId: message?.from || 'unknown'
      });
    }
  }

  async checkSessionExists(sessionId) {
    return this.clients.has(sessionId);
  }

  async initializeAndListen(sessionId) {
    try {
      const sessionExists = await this.checkSessionExists(sessionId);
      
      let initResult = { sessionAlreadyExists: sessionExists };
      
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

  async cleanupSession(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      logger.warn(`Intentando limpiar sesión inexistente: ${sessionId}`);
      return;
    }

    try {
      if (this.restorationPromises[sessionId]) {
        logger.debug(`🧹 Limpiando promesa de restauración pendiente para sesión ${sessionId}`);
        this.restorationPromises[sessionId].reject(new Error('Session cleanup requested'));
        delete this.restorationPromises[sessionId];
      }

      if (session.isListening) {
        this.stopListening(sessionId);
      }

      if (session.client) {
        await session.client.destroy();
      }
      
      chatService.clearCache(sessionId);
      socketService.markSessionDisconnected(sessionId);
      
    } catch (error) {
      logger.error(`Error al limpiar la sesión ${sessionId}:`, {
        errorMessage: error.message,
        sessionId,
        stack: error.stack
      });
    } finally {
      this.clients.delete(sessionId);
      logger.info(`Sesión ${sessionId} eliminada`);
    }
  }

  // ✅ MÉTODO ACTUALIZADO: getSessionInfo sin referencias a buffers
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

    return {
      exists: true,
      sessionId,
      isListening: session.isListening,
      isConnected: session.isConnected,
      // ✅ ELIMINADO: totalBufferSize, bufferStats, activeTimers
      clientInfo,
      socketConnections: socketService.getConnectionCount(sessionId),
      chatFiltersCount: session.chatFilters ? session.chatFilters.size : 0,
      isRestoring: this.isRestoring(sessionId),
      readyAt: session.readyAt
    };
  }

  async getSessionStatus(sessionId) {
    const client = this.clients.get(sessionId);

    if (!client) {
      return {
        exists: false,
        isConnected: false,
        isListening: false
      };
    }

    return {
      exists: true,
      isConnected: client.isConnected || false,
      isListening: client.isListening || false
    };
  }

  // ✅ MÉTODO ACTUALIZADO: getAllSessions sin referencias a buffers
  async getAllSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.clients.entries()) {
      sessions.push({
        sessionId,
        isListening: session.isListening,
        isConnected: session.isConnected || false,
        // ✅ ELIMINADO: bufferSize
        isRestoring: this.isRestoring(sessionId),
        readyAt: session.readyAt
      });
    }
    return sessions;
  }

  // ✅ MÉTODOS DE CHATS: Mantenidos sin cambios
  async getSessionChats(sessionId, forceRefresh = false, limit = 50, offset = 0) {
    try {
      logger.info(`Obteniendo chats para sesión ${sessionId} (limit: ${limit}, offset: ${offset}, refresh: ${forceRefresh})`);
      
      const session = this.clients.get(sessionId);
      if (!session || !session.client) {
        throw new Error(`Sesión ${sessionId} no encontrada o no inicializada`);
      }

      const client = session.client;
      
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        throw new Error(`Cliente WhatsApp no está conectado. Estado actual: ${state}`);
      }

      const allChats = await client.getChats();
      const totalChats = allChats.length;
      
      logger.info(`Total de chats encontrados: ${totalChats} para sesión ${sessionId}`);
      
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
                picture: null // Se obtiene después si es necesario
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
                picture: null
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
   * Obtiene chats básicos con fotos de perfil (versión optimizada)
   * @param {string} sessionId - ID de la sesión
   * @param {number} limit - Límite de chats
   * @param {number} offset - Offset para paginación
   * @returns {Object} Lista básica de chats con fotos de perfil
   */
  async getBasicSessionChats(sessionId, limit = 20, offset = 0) {
    try {
      logger.info(`Obteniendo chats básicos con fotos para sesión ${sessionId} (limit: ${limit}, offset: ${offset})`);
      
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
      
      // Obtener los chats paginados
      const paginatedChats = allChats.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
      
      // Procesar chats de forma asíncrona para incluir fotos de perfil
      const basicChats = await Promise.all(
        paginatedChats.map(async (chat, index) => {
          try {
            // Información básica del chat
            const basicChatInfo = {
              id: chat.id._serialized,
              name: chat.name || chat.id.user || 'Sin nombre',
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              timestamp: chat.timestamp || Date.now(),
              lastMessagePreview: chat.lastMessage?.body?.substring(0, 50) || '',
              isMuted: chat.isMuted || false,
              picture: null // Inicializar como null
            };

            // Obtener la foto de perfil con timeout
            try {
              let profilePicUrl = null;
              logger.info(`ES GRUPOOOOO ${chat.id._serialized}: ${chat.isGroup}`);
              if (chat.isGroup) {
                // Para grupos, usar getProfilePicUrl del chat directamente
                profilePicUrl = await Promise.race([
                  client.getProfilePicUrl(chat.id._serialized),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout foto grupo')), 3000)
                  )
                ]);
                
                logger.info(`foto de perfil para chat ${chat.id._serialized}: ${profilePicUrl}`);
              } else {
                // Para chats individuales, obtener contacto y luego su foto
                const contact = await Promise.race([
                  chat.getContact(),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout contacto')), 2000)
                  )
                ]);
                
                if (contact) {
                  profilePicUrl = await Promise.race([
                    contact.getProfilePicUrl(),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Timeout foto contacto')), 3000)
                    )
                  ]);
                  
                  // Actualizar el nombre con información del contacto si está disponible
                  if (contact.name || contact.pushname) {
                    basicChatInfo.name = contact.name || contact.pushname || basicChatInfo.name;
                  }
                }
              }
              
              basicChatInfo.picture = profilePicUrl;

            } catch (picError) {
              // En caso de error obteniendo la foto, simplemente dejar como null
              logger.debug(`No se pudo obtener foto de perfil para chat ${chat.id._serialized}: ${picError.message}`);
              basicChatInfo.picture = null;
            }

            return basicChatInfo;
            
          } catch (error) {
            logger.warn(`Error procesando chat básico ${index}: ${error.message}`);
            return {
              id: `error-${index}`,
              name: 'Error al cargar chat',
              isGroup: false,
              unreadCount: 0,
              timestamp: Date.now(),
              lastMessagePreview: '',
              isMuted: false,
              picture: null,
              error: true
            };
          }
        })
      );

      logger.info(`Procesados ${basicChats.length} chats básicos con fotos para sesión ${sessionId}`);

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

  async updateChatListeningStatus(sessionId, chatId, isListening) {
    const session = this.clients.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada`);
    }

    if (!chatId || typeof chatId !== 'string') {
      throw new Error('chatId inválido');
    }

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

  // ✅ MÉTODOS DE RECONEXIÓN: Mantenidos sin cambios
  async reconnectSession(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session) {
      throw new Error(`Sesión ${sessionId} no encontrada para reconectar`);
    }

    try {
      logger.info(`Iniciando reconexión para sesión ${sessionId}`);
      
      this.updateSessionActivity(sessionId);
      
      if (session.client) {
        const state = await session.client.getState();
        logger.debug(`Estado actual del cliente ${sessionId}: ${state}`);
        
        if (state === 'CONNECTED') {
          return {
            status: 'already_connected',
            message: 'La sesión ya está conectada'
          };
        }
        
        if (state === 'CONFLICT' || state === 'DEPRECATED_VERSION') {
          logger.warn(`Estado problemático detectado (${state}), recreando cliente para sesión ${sessionId}`);
          await this.destroyClient(sessionId);
          return await this.initializeClient(sessionId);
        }
        
        if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
          logger.info(`Cliente desvinculado, necesita nuevo QR para sesión ${sessionId}`);
          return {
            status: 'qr_required',
            message: 'Se necesita escanear un nuevo código QR'
          };
        }
      }
      
      // Si llegamos aquí, intentar inicialización normal
      return await this.initializeClient(sessionId);
      
    } catch (error) {
      logger.error(`Error durante reconexión de sesión ${sessionId}:`, {
        errorMessage: error.message,
        stack: error.stack
      });

      // En caso de error, limpiar y reinicializar
      try {
        await this.destroyClient(sessionId);
        return await this.initializeClient(sessionId);
      } catch (reinitError) {
        logger.error(`Error durante reinicialización de sesión ${sessionId}:`, {
          errorMessage: reinitError.message
        });
        throw new Error(`No se pudo reconectar la sesión: ${reinitError.message}`);
      }
    }
  }

  /**
   * Destruye un cliente específico sin eliminar la sesión del mapa
   * @param {string} sessionId - ID de la sesión
   */
  async destroyClient(sessionId) {
    const session = this.clients.get(sessionId);
    if (!session || !session.client) {
      return;
    }

    try {
      logger.info(`Destruyendo cliente para sesión ${sessionId}`);

      //  Limpiar promesa de restauración si existe
      if (this.restorationPromises[sessionId]) {
        logger.debug(`🧹 Limpiando promesa de restauración durante destrucción para sesión ${sessionId}`);
        this.restorationPromises[sessionId].reject(new Error('Client destroyed'));
        delete this.restorationPromises[sessionId];
      }
      
      // Detener escucha si está activa
      if (session.isListening) {
        session.client.removeAllListeners('message');
        session.isListening = false;
      }
      
      // Destruir cliente
      await session.client.destroy();
      
      // Mantener la estructura de sesión pero limpiar el cliente
      session.client = null;
      session.isConnected = false;// Marcar como desconectado
      session.lastActivity = Date.now();
      session.reconnectionAttempts = (session.reconnectionAttempts || 0) + 1;
      
      logger.info(`Cliente destruido para sesión ${sessionId}`);
      
    } catch (error) {
      logger.error(`Error al destruir cliente para sesión ${sessionId}:`, {
        errorMessage: error.message
      });
    }
  }

  /**
   * Actualiza el timestamp de última actividad de una sesión
   * @param {string} sessionId - ID de la sesión
   */
  updateSessionActivity(sessionId) {
    const session = this.clients.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      logger.debug(`Actividad actualizada para sesión ${sessionId}`);
    }
  }

  /**
   * Limpia sesiones expiradas y libera recursos
   * @param {boolean} force - Si true, fuerza la limpieza incluso de sesiones activas
   * @returns {Promise<Object>} - Resultado de la limpieza
   */
  async cleanupExpiredSessions(force = false) {
    const now = Date.now();
    const expiredThreshold = 24 * 60 * 60 * 1000; // 24 horas
    const inactiveThreshold = 2 * 60 * 60 * 1000;  // 2 horas para marcar como inactiva
    
    const results = {
      totalSessions: this.clients.size,
      expiredSessions: [],
      inactiveSessions: [],
      cleanedSessions: [],
      errors: []
    };

    logger.info(`Iniciando limpieza de sesiones (force: ${force})`);

    // ✅ También limpiar promesas huérfanas durante la limpieza
    this.cleanupOrphanedPromises();

    for (const [sessionId, session] of this.clients.entries()) {
      try {
        const lastActivity = session.lastActivity || session.createdAt || 0;
        const timeSinceActivity = now - lastActivity;
        
        // Marcar sesiones inactivas
        if (timeSinceActivity > inactiveThreshold) {
          results.inactiveSessions.push({
            sessionId,
            lastActivity: new Date(lastActivity),
            timeSinceActivity: Math.round(timeSinceActivity / 1000 / 60) // minutos
          });
        }
        
        // Identificar sesiones expiradas

        const shouldCleanup = force || 
          timeSinceActivity > expiredThreshold ||
          (session.reconnectionAttempts && session.reconnectionAttempts > 5) ||
          (!session.client && timeSinceActivity > inactiveThreshold);
        
        if (shouldCleanup) {
          results.expiredSessions.push({
            sessionId,
            reason: force ? 'forced' : 
                    timeSinceActivity > expiredThreshold ? 'expired' :
                    session.reconnectionAttempts > 5 ? 'too_many_retries' : 'inactive_no_client',
            lastActivity: new Date(lastActivity),
            reconnectionAttempts: session.reconnectionAttempts || 0
          });

           // Limpiar la sesión
          try {
            await this.cleanupSession(sessionId);
            results.cleanedSessions.push(sessionId);
            logger.info(`Sesión expirada limpiada: ${sessionId}`);
          } catch (cleanupError) {
            results.errors.push({
              sessionId,
              error: cleanupError.message
            });
            logger.error(`Error al limpiar sesión expirada ${sessionId}:`, {
              errorMessage: cleanupError.message
            });
          }
        }
        
      } catch (error) {
        results.errors.push({
          sessionId,
          error: error.message
        });
        logger.error(`Error al evaluar sesión para limpieza ${sessionId}:`, {
          errorMessage: error.message
        });
      }
    }

    logger.info(`Limpieza completada. Sesiones limpiadas: ${results.cleanedSessions.length}`);
    return results;
  }

    /**
   * Obtiene estadísticas detalladas de las sesiones
   * @returns {Promise<Object>} - Estadísticas completas
   */ 
   async getSessionsStatistics() {
    const now = Date.now();
    const stats = {
      total: this.clients.size,
      connected: 0,
      listening: 0,
      inactive: 0,
      hasErrors: 0,
      restoring: 0,
      sessionDetails: [],
      limits: {
        maxSessions: config.maxSessions,
        usagePercentage: Math.round((this.clients.size / config.maxSessions) * 100)
      }
    };

    for (const [sessionId, session] of this.clients.entries()) {
      try {
        const sessionInfo = await this.getSessionInfo(sessionId);
        
        // Contadores generales
        if (sessionInfo.isConnected) stats.connected++;
        if (sessionInfo.isListening) stats.listening++;
        if (sessionInfo.isRestoring) stats.restoring++;// Contar sesiones en restauración
        
        const lastActivity = session.lastActivity || session.createdAt || 0;
        const timeSinceActivity = now - lastActivity;
        
        if (timeSinceActivity > 2 * 60 * 60 * 1000) { // 2 horas
          stats.inactive++;
        }
        
        if (session.reconnectionAttempts && session.reconnectionAttempts > 0) {
          stats.hasErrors++;
        }
        
        
        stats.sessionDetails.push({
          sessionId,
          isConnected: sessionInfo.isConnected,
          isListening: sessionInfo.isListening,
          isRestoring: sessionInfo.isRestoring,
          // ✅ ELIMINADO: bufferSize, activeTimers
          lastActivity: new Date(lastActivity),
          timeSinceActivity: Math.round(timeSinceActivity / 1000 / 60), // minutos
          reconnectionAttempts: session.reconnectionAttempts || 0,
          socketConnections: sessionInfo.socketConnections || 0,
          readyAt: session.readyAt
        });
        
      } catch (error) {
        logger.error(`Error al obtener estadísticas para sesión ${sessionId}:`, {
          errorMessage: error.message
        });
        
        stats.sessionDetails.push({
          sessionId,
          error: error.message,
          lastActivity: new Date(session.lastActivity || 0),
          isRestoring: this.isRestoring(sessionId)// Verificar estado de restauración incluso en error
        });
      }
    }

    // Ordenar por última actividad (más reciente primero)
    stats.sessionDetails.sort((a, b) => {
      const aTime = a.lastActivity ? a.lastActivity.getTime() : 0;
      const bTime = b.lastActivity ? b.lastActivity.getTime() : 0;
      return bTime - aTime;
    });

    return stats;
  }

    /**
   * Implementa reconexión automática para sesiones desconectadas
   * @param {string} sessionId - ID de la sesión
   * @param {string} reason - Razón de la desconexión
   */
  async handleAutomaticReconnection(sessionId, reason) {
    const session = this.clients.get(sessionId);
    if (!session) return;

    // Actualizar contador de intentos de reconexión
    session.reconnectionAttempts = (session.reconnectionAttempts || 0) + 1;
    session.lastDisconnection = Date.now();
    session.lastDisconnectionReason = reason;

    logger.info(`Analizando desconexión de sesión ${sessionId}`, {
      reason,
      attempts: session.reconnectionAttempts
    });

    // Razones que NO requieren reconexión automática
    const permanentDisconnections = [
      'LOGOUT',
      'BANNED',
      'DEPRECATED_VERSION',
      'USER_LOGOUT'
    ];

    if (permanentDisconnections.includes(reason)) {
      logger.info(`Desconexión permanente detectada para sesión ${sessionId}: ${reason}`);
      return;
    }

    // Límite de intentos de reconexión
    if (session.reconnectionAttempts > 5) {
      logger.warn(`Demasiados intentos de reconexión para sesión ${sessionId}, marcando como problemática`);
      return;
    }

    // Razones que indican problemas temporales de red
    const temporaryDisconnections = [
      'NAVIGATION',
      'CONFLICT_RESTART',
      'CONNECTION_MAIN_SYNC_NOT_CONNECTED',
      'Lost connection with WhatsApp'
    ];

    if (temporaryDisconnections.some(temp => reason.includes(temp))) {
      const delayMs = Math.min(5000 * session.reconnectionAttempts, 30000); // Backoff exponencial hasta 30s
      
      logger.info(`Programando reconexión automática para sesión ${sessionId} en ${delayMs}ms`);
      
      setTimeout(async () => {
        try {
          await this.reconnectSession(sessionId);
          logger.info(`Reconexión automática iniciada para sesión ${sessionId}`);
        } catch (error) {
          logger.error(`Error en reconexión automática para sesión ${sessionId}:`, {
            errorMessage: error.message
          });
        }
      }, delayMs);
    }
  }

}

module.exports = new WhatsAppService();