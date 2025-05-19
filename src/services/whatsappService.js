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
      
      // Marcar sesión como conectada en el servicio QR (esto también lo emitirá por socket)
      qrService.markSessionConnected(sessionId);
      
      try {
        // Iniciar escucha
        const listenResult = await this.startListening(sessionId);
        logger.info(`Escucha iniciada automáticamente para sesión ${sessionId}: ${JSON.stringify(listenResult)}`);
      } catch (error) {
        logger.error(`Error al iniciar escucha automática para sesión ${sessionId}: ${error.message}`);
      }
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

    // Configurar el manejador de mensajes
    session.client.on('message', (message) => this.handleMessage(sessionId, message));
    
    // Marcar como escuchando
    session.isListening = true;
    logger.info(`Modo escucha activado para la sesión ${sessionId}`);
    
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
    this.sendRemainingMessages(sessionId);
    
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
      logger.error(`Error al procesar mensaje en sesión ${sessionId}:`, error);
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
      logger.error(`Error al enviar chunk de mensajes a n8n para chatId ${chatId} en sesión ${sessionId}:`, error);
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
    if (!session) return;

    try {
      // Detener la escucha si está activa
      if (session.isListening) {
        this.stopListening(sessionId);
      }

      // Cerrar cliente
      if (session.client) {
        await session.client.destroy();
      }
    } catch (error) {
      logger.error(`Error al limpiar la sesión ${sessionId}:`, error);
    } finally {
      // Eliminar del mapa de clientes
      this.clients.delete(sessionId);
      logger.info(`Sesión ${sessionId} eliminada`);
    }
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
}

module.exports = new WhatsAppService();