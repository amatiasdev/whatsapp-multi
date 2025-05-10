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
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Se requiere sessionId' });
      }

      // Usar el método combinado
      const result = await whatsappService.initializeAndListen(sessionId);
      logger.info(`Inicialización y escucha: ${JSON.stringify(result)}`);

      return res.status(200).json({
        success: true,
        ...result
      });

    } catch (error) {
      logger.error('Error al inicializar e iniciar escucha:', error);
      return res.status(500).json({
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
}

module.exports = new SessionController();