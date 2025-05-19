const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// Puerto para el webhook mock
const PORT = process.env.MOCK_WEBHOOK_PORT || 5678;

// Directorio para almacenar mensajes recibidos
const messagesDir = path.join(__dirname, 'received-messages');
if (!fs.existsSync(messagesDir)) {
  fs.mkdirSync(messagesDir, { recursive: true });
}

// Middleware para parsear JSON
app.use(express.json({ limit: '10mb' }));

// Función para guardar mensajes recibidos
const saveMessage = (chatId, data) => {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const filename = path.join(messagesDir, `${chatId}_${timestamp}.json`);
  
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`Mensaje guardado en: ${filename}`);
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
    });
    
    // Guardar los mensajes para referencia
    saveMessage(payload.chatId, payload);
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
        return {
          filename: file,
          timestamp: file.split('_')[1].replace('.json', ''),
          chatId: file.split('_')[0],
          messageCount: JSON.parse(content).messages?.length || 0
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

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 Webhook Mock para WhatsApp iniciado en puerto ${PORT}`);
  console.log(`\n📮 URL para configurar en .env: http://localhost:${PORT}/webhook/whatsapp-messages`);
  console.log(`\n📋 Endpoints disponibles:`);
  console.log(`   - POST /webhook/whatsapp-messages   (recibe mensajes de WhatsApp)`);
  console.log(`   - GET  /health                     (verificación de estado)`);
  console.log(`   - GET  /messages                   (lista mensajes recibidos)`);
  console.log(`   - GET  /messages/:filename         (ver detalles de un mensaje específico)`);
  
  console.log(`\n💾 Los mensajes recibidos se guardarán en: ${messagesDir}`);
  console.log(`\n📢 Listo para recibir mensajes de WhatsApp. Configura BACKEND_WEBHOOK_URL=http://localhost:${PORT}/webhook/whatsapp-messages en tu .env\n`);
});