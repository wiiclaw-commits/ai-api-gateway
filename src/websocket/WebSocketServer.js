import { WebSocketServer } from 'ws';
import winston from 'winston';

const logger = winston.createLogger();

/**
 * WebSocket 服务器 - 实时推送 Agent 状态和任务变化
 */
export class WebSocketServerImpl {
  constructor(server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws'
    });

    this.clients = new Set();
    this.setupHandlers();

    logger.info('WebSocket server initialized');
  }

  setupHandlers() {
    this.wss.on('connection', (ws) => {
      logger.info('WebSocket client connected');
      this.clients.add(ws);

      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error.message);
        this.clients.delete(ws);
      });

      // 发送欢迎消息
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to API Gateway WebSocket',
        timestamp: Date.now()
      }));
    });
  }

  /**
   * 广播消息到所有连接的客户端
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    });
  }

  /**
   * 发送 Agent 状态更新
   */
  sendAgentUpdate(agent) {
    this.broadcast({
      type: 'agent:update',
      agent,
      timestamp: Date.now()
    });
  }

  /**
   * 发送任务状态更新
   */
  sendTaskUpdate(task) {
    this.broadcast({
      type: 'task:update',
      task,
      timestamp: Date.now()
    });
  }

  /**
   * 发送会话更新
   */
  sendSessionUpdate(session) {
    this.broadcast({
      type: 'session:update',
      session,
      timestamp: Date.now()
    });
  }

  /**
   * 发送日志更新
   */
  sendLogUpdate(log) {
    this.broadcast({
      type: 'log:update',
      log,
      timestamp: Date.now()
    });
  }
}

export default WebSocketServerImpl;
