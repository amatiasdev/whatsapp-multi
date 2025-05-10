require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const winston = require('winston');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Crear directorio para la sesión si no existe
const SESSION_DIR = path.join(__dirname, 'sessions', process.env.SESSION_NAME || 'default');
fs.mkdirSync(SESSION_DIR, { recursive: true });

// Configuración de logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'whatsapp-listener.log' })
  ]
});

// Configuración del cliente de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESSION_DIR
  }),
  puppeteer: {
    headless: process.env.HEADLESS === 'true',
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

// Configurar aplicación Express
const app = express();
app.use(express.json());

// Variables para el estado del listener
let isListening = false;
let messageStore = {};
let chunkSendInterval = null;

// Inicializar cliente de WhatsApp
client.initialize();

// Manejar evento de código QR
client.on('qr', (qr) => {
  logger.info('QR Code recibido, escanee con WhatsApp:');
  qrcode.generate(qr, { small: true });
  
  // También guardar el QR como texto en un archivo para acceso fácil
  fs.writeFileSync('latest-qr.txt', qr);
  logger.info('QR Code guardado en archivo latest-qr.txt');
});

// Manejar evento de autenticación
client.on('authenticated', () => {
  logger.info('Autenticación exitosa');
});

// Manejar evento de inicio de sesión
client.on('ready', () => {
  logger.info('Cliente WhatsApp listo y conectado');
});

// Manejar desconexión
client.on('disconnected', (reason) => {
  logger.warn(`Cliente desconectado: ${reason}`);
  // Detener la escucha si estaba activa
  if (isListening) {
    stopListening();
  }
});

// Endpoint para iniciar escucha
app.post('/start-listening', (req, res) => {
  // Verificar si el cliente está listo
  if (!client.info) {
    return res.status(400).json({
      success: false,
      message: 'El cliente de WhatsApp no está listo. Escanee el código QR primero.'
    });
  }

  // Si ya está escuchando, detener primero
  if (isListening) {
    stopListening();
  }

  // Iniciar escucha
  startListening();

  res.status(200).json({
    success: true,
    message: 'Escucha iniciada correctamente'
  });
});

// Endpoint para detener escucha
app.post('/stop-listening', (req, res) => {
  if (!isListening) {
    return res.status(400).json({
      success: false,
      message: 'El sistema no está en modo escucha actualmente'
    });
  }

  // Detener escucha
  stopListening();

  res.status(200).json({
    success: true,
    message: 'Escucha detenida correctamente'
  });
});

// Endpoint para verificar estado
app.get('/status', (req, res) => {
  const status = {
    clientReady: !!client.info,
    isListening: isListening,
    activeChats: Object.keys(messageStore).length,
    messagesInQueue: Object.values(messageStore)
      .reduce((total, chat) => total + chat.length, 0)
  };

  res.status(200).json(status);
});

// Función para iniciar la escucha
function startListening() {
  if (isListening) return;

  // Resetear almacén de mensajes
  messageStore = {};
  
  // Configurar manejador de mensajes
  client.on('message', handleIncomingMessage);
  
  // Iniciar intervalo para enviar chunks
  const interval = parseInt(process.env.MESSAGE_CHUNK_INTERVAL_MS) || 30000;
  chunkSendInterval = setInterval(sendMessageChunks, interval);
  
  isListening = true;
  logger.info('Modo escucha activado');
}

// Función para detener la escucha
function stopListening() {
  if (!isListening) return;
  
  // Remover manejador de mensajes
  client.removeListener('message', handleIncomingMessage);
  
  // Detener intervalo de envío
  if (chunkSendInterval) {
    clearInterval(chunkSendInterval);
    chunkSendInterval = null;
  }
  
  // Enviar mensajes restantes
  sendMessageChunks(true);
  
  // Limpiar almacén
  messageStore = {};
  
  isListening = false;
  logger.info('Modo escucha desactivado');
}

// Función para manejar mensajes entrantes
function handleIncomingMessage(message) {
  if (!isListening) return;
  
  const chatId = message.from;
  
  // Obtener información adicional sobre el mensaje
  const messageData = {
    id: message.id.id,
    timestamp: message.timestamp,
    from: message.from,
    body: message.body,
    hasMedia: message.hasMedia,
    type: message.type,
    // Añadir información del chat si es posible
    chat: {
      name: message._data.notifyName || 'Unknown',
      isGroup: chatId.includes('@g.us')
    }
  };
  
  // Inicializar array para el chat si no existe
  if (!messageStore[chatId]) {
    messageStore[chatId] = [];
  }
  
  // Añadir mensaje al almacén
  messageStore[chatId].push(messageData);
  
  logger.debug(`Mensaje recibido de ${chatId}: ${message.body.substring(0, 30)}...`);
  
  // Verificar si debemos enviar inmediatamente
  const chunkSize = parseInt(process.env.MESSAGE_CHUNK_SIZE) || 5;
  if (messageStore[chatId].length >= chunkSize) {
    sendMessageChunkForChat(chatId);
  }
}

// Función para enviar chunks de mensajes
function sendMessageChunks(sendAll = false) {
  // Si no hay mensajes, no hacer nada
  if (Object.keys(messageStore).length === 0) return;
  
  // Procesar cada chat
  for (const chatId in messageStore) {
    // Si hay mensajes o estamos enviando todo
    if (messageStore[chatId].length > 0 && 
       (sendAll || messageStore[chatId].length >= parseInt(process.env.MESSAGE_CHUNK_SIZE) || 5)) {
      sendMessageChunkForChat(chatId);
    }
  }
}

// Función para enviar chunk de un chat específico
async function sendMessageChunkForChat(chatId) {
  // Si no hay mensajes, salir
  if (!messageStore[chatId] || messageStore[chatId].length === 0) return;
  
  // Obtener los mensajes a enviar
  const messages = [...messageStore[chatId]];
  
  // Limpiar mensajes del almacén
  messageStore[chatId] = [];
  
  // Preparar payload
  const payload = {
    chatId: chatId,
    timestamp: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages
  };
  
  // Enviar al webhook
  try {
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new Error('N8N_WEBHOOK_URL no configurada en .env');
    }
    
    const response = await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 segundos
    });
    
    logger.info(`Chunk de ${messages.length} mensajes enviado a n8n para ${chatId}. Respuesta: ${response.status}`);
  } catch (error) {
    logger.error(`Error al enviar mensajes a n8n: ${error.message}`);
    
    // Devolver mensajes al almacén para reintentar después
    if (!messageStore[chatId]) {
      messageStore[chatId] = [];
    }
    messageStore[chatId] = [...messages, ...messageStore[chatId]];
  }
}

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Servidor iniciado en puerto ${PORT}`);
});

// Manejar apagado gracioso
process.on('SIGINT', async () => {
  logger.info('Deteniendo servicios...');
  
  // Detener escucha
  if (isListening) {
    stopListening();
  }
  
  // Destruir cliente de WhatsApp
  try {
    await client.destroy();
    logger.info('Cliente de WhatsApp desconectado correctamente');
  } catch (err) {
    logger.error(`Error al desconectar cliente: ${err.message}`);
  }
  
  process.exit(0);
});