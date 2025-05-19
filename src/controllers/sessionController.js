const whatsappService = require('../services/whatsappService');
const logger = require('../utils/logger');

class SessionController {
  async initializeSession(req, res) {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const result = await whatsappService.initializeClient(sessionId);
      logger.info(`Inicialización de sesión: ${JSON.stringify(result)}`);
      
      return res.status(200).json({ 
        success: true, 
        ...result
      });
    } catch (error) {
      logger.error('Error al inicializar sesión:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async startListening(req, res) {
    try {
      const { sessionId = 'default' } = req.body;
      
      logger.info(`POST /api/session/start-listening`);
      
      // Verificar si la sesión ya existe
      const sessionExists = await whatsappService.checkSessionExists(sessionId);
      
      // Si la sesión existe y ya está conectada, solo iniciamos escucha
      if (sessionExists) {
        const status = await whatsappService.getSessionStatus(sessionId);
        
        if (status.isConnected) {
          // La sesión ya existe y está conectada, podemos iniciar escucha directamente
          const listenResult = await whatsappService.startListening(sessionId);
          return res.status(200).json({
            success: true,
            sessionId,
            status: 'connected',
            listening: listenResult
          });
        }
      }
      
      // Si llegamos aquí, necesitamos inicializar o reconectar
      const result = await whatsappService.initializeAndListen(sessionId);
      
      // Respuesta más precisa sobre el estado real
      res.status(200).json({
        success: true,
        sessionId,
        status: 'initializing',
        message: sessionExists 
          ? "Reconectando sesión existente, escanee el código QR" 
          : "Iniciando nueva sesión, escanee el código QR",
        initialization: result.initialization
      });
      
    } catch (error) {
      logger.error(`Error al iniciar sesión: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async stopListening(req, res) {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const result = whatsappService.stopListening(sessionId);
      logger.info(`Detención de escucha: ${JSON.stringify(result)}`);
      
      return res.status(200).json({ 
        success: true, 
        ...result
      });
    } catch (error) {
      logger.error('Error al detener escucha:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getSessionStatus(req, res) {
    try {
      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      const status = await whatsappService.getSessionStatus(sessionId);
      return res.status(200).json({ 
        success: true, 
        status
      });
    } catch (error) {
      logger.error('Error al obtener estado de sesión:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getAllSessions(req, res) {
    try {
      const sessions = await whatsappService.getAllSessions();
      return res.status(200).json({ 
        success: true, 
        sessions
      });
    } catch (error) {
      logger.error('Error al obtener todas las sesiones:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async cleanupSession(req, res) {
    try {
      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }
      
      await whatsappService.cleanupSession(sessionId);
      return res.status(200).json({ 
        success: true, 
        message: `Sesión ${sessionId} eliminada correctamente`
      });
    } catch (error) {
      logger.error('Error al eliminar sesión:', error);
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async checkConnectionStatus (req, res) {
    try {
      const { sessionId = 'default' } = req.params;
      
      logger.debug(`GET /api/session/${sessionId}/connection-status`);
      
      const status = await whatsappService.getSessionStatus(sessionId);
      
      // Determinar estado detallado
      let connectionStatus = 'disconnected';
      
      if (status.exists) {
        if (status.isConnected) {
          connectionStatus = 'connected';
          if (status.isListening) {
            connectionStatus = 'listening';
          }
        } else {
          connectionStatus = 'initializing';
          // Comprobar si hay un QR disponible
          const qrAvailable = await qrService.getQR(sessionId) !== null;
          if (qrAvailable) {
            connectionStatus = 'waiting_for_scan';
          }
        }
      }
      
      res.status(200).json({
        success: true,
        sessionId,
        connectionStatus,
        details: status
      });
      
    } catch (error) {
      logger.error(`Error al obtener estado de conexión: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };
}

module.exports = new SessionController();