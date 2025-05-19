# WhatsApp Multi-Session API

Sistema de backend que permite conectar múltiples sesiones de WhatsApp personal (no Business) a través de una API REST. Está diseñado específicamente para integrarse con plataformas de automatización como n8n, permitiendo escuchar mensajes entrantes de chats específicos y procesarlos mediante webhooks.

## Características Principales

* **Múltiples sesiones independientes**: Cada sesión tiene su propio inicio de sesión con QR independiente
* **API REST completa**: Endpoints para crear/gestionar sesiones y controlar la escucha de mensajes
* **Interfaz web para QR**: Página simple para escanear los códigos QR de WhatsApp
* **Webhooks configurables**: Cada sesión puede enviar mensajes a diferentes webhooks
* **Escucha selectiva**: Capacidad de escuchar todos los chats o sólo chats específicos
* **Persistencia de sesiones**: Las sesiones se mantienen activas entre reinicios
* **Integración con n8n**: Diseñado para trabajar perfectamente con flujos de n8n

## Requisitos

- Node.js 16+ (recomendado 18+)
- npm o yarn
- Navegador con soporte para WebSocket

## Instalación y Ejecución

### Método 1: Instalación local

1. Clonar el repositorio:

```bash
git clone https://github.com/tuusuario/whatsapp-multi-session-api.git
cd whatsapp-multi-session-api
```

2. Instalar dependencias:

```bash
npm install
```

3. Crear un archivo `.env` (opcional):

```
PORT=3001
HOST=localhost
LOG_LEVEL=info
```

4. Iniciar el servidor:

```bash
node src/server.js
```
4.1 Iniciar el servidor que simula n8n:


PS C:\Users\Aldo> Invoke-RestMethod -Method Post `
   -Uri http://localhost:3000/api/session/initialize `
   -Headers @{ "Content-Type" = "application/json" } `
   -Body '{"sessionId":"test-session"}'

success status      clientId
------- ------      --------
   True initialized test-session


PS C:\Users\Aldo> Invoke-RestMethod -Method Post `
   -Uri http://localhost:3000/api/session/start-listening `
   -Headers @{ "Content-Type" = "application/json" } `
   -Body '{"sessionId":"test-session"}'

success status
------- ------
   True listening_started


PS C:\Users\Aldo> Invoke-RestMethod -Method Post `
   -Uri http://localhost:3000/api/session/stop-listening `
   -Headers @{ "Content-Type" = "application/json" } `
   -Body '{"sessionId":"test-session"}'

```bash
node start-services.js
```
5. Abrir en el navegador: `http://localhost:3000`

### Método 2: Usando Docker

1. Clonar el repositorio:

```bash
git clone https://github.com/tuusuario/whatsapp-multi-session-api.git
cd whatsapp-multi-session-api
```

2. Construir y ejecutar con Docker Compose:

```bash
docker-compose up -d
```

3. Abrir en el navegador: `http://localhost:3000`

## Uso Básico

1. Accede a la interfaz web (`http://localhost:3000`)
2. Crea una nueva sesión
3. Escanea el código QR con tu WhatsApp
4. Una vez conectado, puedes usar la API REST para gestionar la sesión

## API REST

La API proporciona los siguientes endpoints principales:

### Gestión de Sesiones

- `POST /api/sessions`: Crear una nueva sesión
- `GET /api/sessions`: Listar todas las sesiones
- `GET /api/sessions/:sessionId`: Obtener información de una sesión
- `DELETE /api/sessions/:sessionId`: Eliminar una sesión
- `GET /api/sessions/:sessionId/status`: Obtener estado detallado de una sesión

### Control de Escucha

- `POST /api/sessions/:sessionId/listen`: Iniciar escucha en una sesión
- `DELETE /api/sessions/:sessionId/listen`: Detener escucha en una sesión
- `GET /api/sessions/:sessionId/chats`: Obtener chats disponibles

### Envío de Mensajes

- `POST /api/sessions/:sessionId/send`: Enviar mensaje

### Webhooks

- `POST /api/webhooks`: Crear un nuevo webhook
- `GET /api/webhooks`: Listar todos los webhooks
- `PUT /api/webhooks/:webhookId`: Actualizar un webhook
- `DELETE /api/webhooks/:webhookId`: Eliminar un webhook
- `POST /api/sessions/:sessionId/webhook`: Asignar webhook a una sesión

## Integración con n8n

Para integrar con n8n, simplemente:

1. Crea un nodo "Webhook" en n8n
2. Configura la URL del webhook
3. Asigna esa URL a una sesión en WhatsApp Multi-Session API
4. Inicia la escucha para los chats deseados

## Consideraciones

- Este proyecto utiliza una librería no oficial (`whatsapp-web.js`) para interactuar con WhatsApp
- No está afiliado de ninguna manera con WhatsApp o Meta
- Usa responsablemente y respeta los términos de servicio de WhatsApp

## Contribuciones

Las contribuciones son bienvenidas. Por favor, abre un issue primero para discutir los cambios que te gustaría hacer.

## Licencia

[MIT](LICENSE)