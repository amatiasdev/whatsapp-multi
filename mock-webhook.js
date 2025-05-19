const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// Puerto para el webhook mock
const PORT = process.env.MOCK_WEBHOOK_PORT || 5678;

// Directorios para almacenar mensajes y medios recibidos
const messagesDir = path.join(__dirname, 'received-messages');
const mediaDir = path.join(__dirname, 'received-media');

// Crear directorios si no existen
if (!fs.existsSync(messagesDir)) {
  fs.mkdirSync(messagesDir, { recursive: true });
}
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Middleware para parsear JSON (aumentar límite para medios grandes)
app.use(express.json({ limit: '50mb' }));

// Función para guardar un archivo de media
const saveMedia = (mediaInfo, chatId, messageId) => {
  if (!mediaInfo || !mediaInfo.data) return null;
  
  try {
    // Crear directorio específico para el chat si no existe
    const chatDir = path.join(mediaDir, sanitizeFilename(chatId));
    if (!fs.existsSync(chatDir)) {
      fs.mkdirSync(chatDir, { recursive: true });
    }
    
    // Generar nombre de archivo
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    let filename = mediaInfo.filename || `${mediaInfo.mediaType}_${timestamp}`;
    filename = sanitizeFilename(filename);
    
    // Ruta completa del archivo
    const filePath = path.join(chatDir, filename);
    
    // Guardar el archivo
    const buffer = Buffer.from(mediaInfo.data, 'base64');
    fs.writeFileSync(filePath, buffer);
    
    // Retornar información del archivo guardado
    return {
      path: filePath,
      relativePath: path.join('received-media', sanitizeFilename(chatId), filename),
      size: buffer.length
    };
  } catch (error) {
    console.error(`Error al guardar medio: ${error.message}`);
    return null;
  }
};

// Función para sanitizar nombres de archivo
const sanitizeFilename = (input) => {
  if (!input) return 'unknown';
  return input.toString().replace(/[^a-z0-9_\-@\.]/gi, '_').substring(0, 100);
};

// Función para guardar mensajes recibidos
const saveMessage = (chatId, data) => {
  try {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filename = path.join(messagesDir, `${sanitizeFilename(chatId)}_${timestamp}.json`);
    
    // Crear una copia del payload para modificarlo
    const savedData = JSON.parse(JSON.stringify(data));
    
    // Procesar los medios en los mensajes
    if (savedData.messages && Array.isArray(savedData.messages)) {
      savedData.messages.forEach(msg => {
        if (msg.media && msg.media.data) {
          // Guardar el medio en disco
          const mediaFile = saveMedia(msg.media, chatId, msg.id);
          
          if (mediaFile) {
            // Guardar información sobre el archivo en lugar del base64
            const mediaInfo = { ...msg.media };
            delete mediaInfo.data; // Eliminar datos base64 para ahorrar espacio
            
            // Agregar información del archivo guardado
            mediaInfo.savedFile = mediaFile;
            
            // Reemplazar los datos de media en el mensaje
            msg.media = mediaInfo;
          }
        }
      });
    }
    
    // Guardar el mensaje modificado
    fs.writeFileSync(filename, JSON.stringify(savedData, null, 2));
    console.log(`Mensaje guardado en: ${filename}`);
    return filename;
  } catch (error) {
    console.error(`Error al guardar mensaje: ${error.message}`);
    return null;
  }
};

// Función para obtener un icono según el tipo de medio
const getMediaIcon = (mediaType) => {
  const icons = {
    'image': '🖼️',
    'video': '🎬',
    'audio': '🎵',
    'ptt': '🎙️', // Voice note
    'document': '📄',
    'sticker': '🏷️',
    'unknown': '📦'
  };
  
  return icons[mediaType] || icons.unknown;
};

// Endpoint principal para recibir mensajes
app.post('/webhook/whatsapp-messages', (req, res) => {
  console.log('\n=============================================');
  console.log('🔔 MENSAJE RECIBIDO DE WHATSAPP');
  console.log('=============================================');
  
  const payload = req.body;
  
  // Mostrar información básica
  console.log(`📱 Sesión: ${payload.sessionId}`);
  console.log(`💬 Chat ID: ${payload.chatId}`);
  console.log(`📨 Mensajes recibidos: ${payload.messages?.length || 0}`);
  
  // Mostrar detalles de cada mensaje
  if (payload.messages && payload.messages.length > 0) {
    console.log('\n📝 CONTENIDO DE LOS MENSAJES:');
    payload.messages.forEach((msg, index) => {
      console.log(`\n🔹 Mensaje #${index + 1}:`);
      console.log(`   De: ${msg.from}`);
      console.log(`   Tipo: ${msg.type}`);
      console.log(`   Contenido: ${msg.body}`);
      console.log(`   Hora: ${new Date(msg.timestamp * 1000).toLocaleString()}`);
      
      // Mostrar información de medios si existe
      if (msg.hasMedia && msg.media) {
        const mediaType = msg.media.mediaType;
        const icon = getMediaIcon(mediaType);
        console.log(`   Medio: ${icon} ${mediaType.toUpperCase()} (${msg.media.mimeType})`);
        
        if (msg.media.filename) {
          console.log(`   Archivo: ${msg.media.filename}`);
        }
        
        if (msg.media.filesize) {
          const sizeInKB = Math.round(msg.media.filesize / 1024);
          console.log(`   Tamaño: ${sizeInKB} KB`);
        }
        
        // Guardar archivo de medios
        const savedFile = saveMedia(msg.media, payload.chatId, msg.id);
        if (savedFile) {
          console.log(`   Guardado en: ${savedFile.relativePath}`);
        }
      }
    });
    
    // Guardar los mensajes para referencia
    const savedFile = saveMessage(payload.chatId, payload);
    if (savedFile) {
      console.log(`\n💾 Mensaje completo guardado: ${savedFile}`);
    }
  }
  
  console.log('\n✅ Mensaje procesado correctamente');
  console.log('=============================================\n');
  
  // Simular procesamiento exitoso (como lo haría n8n)
  setTimeout(() => {
    res.status(200).json({
      success: true,
      message: 'Mensajes recibidos correctamente',
      timestamp: new Date().toISOString()
    });
  }, 500); // Pequeño retraso para simular procesamiento
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'mock-webhook'
  });
});

// Endpoint para ver mensajes almacenados
app.get('/messages', (req, res) => {
  try {
    const files = fs.readdirSync(messagesDir);
    const messages = files
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(messagesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        return {
          filename: file,
          timestamp: file.split('_')[1]?.replace('.json', '') || 'unknown',
          chatId: file.split('_')[0] || 'unknown',
          messageCount: data.messages?.length || 0,
          hasMedia: data.messages?.some(m => m.media) || false
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para ver detalles de un mensaje específico
app.get('/messages/:filename', (req, res) => {
  try {
    const filePath = path.join(messagesDir, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    res.status(200).json(JSON.parse(content));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para servir archivos de medios
app.use('/media', express.static(mediaDir));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 Webhook Mock para WhatsApp iniciado en puerto ${PORT}`);
  console.log(`\n📮 URL para configurar en .env: http://localhost:${PORT}/webhook/whatsapp-messages`);
  console.log(`\n📋 Endpoints disponibles:`);
  console.log(`   - POST /webhook/whatsapp-messages   (recibe mensajes de WhatsApp)`);
  console.log(`   - GET  /health                     (verificación de estado)`);
  console.log(`   - GET  /messages                   (lista mensajes recibidos)`);
  console.log(`   - GET  /messages/:filename         (ver detalles de un mensaje específico)`);
  console.log(`   - GET  /media/:chatId/:filename    (acceder a los archivos de medios guardados)`);
  
  console.log(`\n💾 Los mensajes recibidos se guardarán en: ${messagesDir}`);
  console.log(`\n🖼️ Los medios recibidos se guardarán en: ${mediaDir}`);
  console.log(`\n📢 Listo para recibir mensajes de WhatsApp. Configura BACKEND_WEBHOOK_URL=http://localhost:${PORT}/webhook/whatsapp-messages en tu .env\n`);
});