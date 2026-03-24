import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import winston from 'winston';
import { createServer } from 'http';
import { router as chatRouter } from './routes/chat.js';
import { router as modelsRouter } from './routes/models.js';
import { router as authRouter } from './routes/auth.js';
import { router as agentsRouter } from './routes/agents.js';
import { healthCheck } from './middleware/health.js';
import { requireAuth } from './middleware/auth.js';
import { WebSocketServerImpl } from './websocket/WebSocketServer.js';
import { setWebSocketServer } from './utils/logger.js';

dotenv.config();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// 创建 HTTP 服务器以支持 WebSocket
const server = createServer(app);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check (不需要认证)
app.get('/health', healthCheck);

// Auth routes (不需要认证)
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/agents', agentsRouter);

// API Routes (需要认证)
app.use('/api/v1/chat', requireAuth, chatRouter);
app.use('/api/v1/models', requireAuth, modelsRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'AI API Gateway',
    version: '1.0.0',
    endpoints: [
      'GET /health',
      'POST /api/v1/chat/completions',
      'GET /api/v1/models'
    ]
  });
});

// Error handling
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(500).json({
    error: {
      message: err.message || 'Internal Server Error',
      type: 'server_error'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Not Found',
      type: 'not_found'
    }
  });
});

// 启动 HTTP 服务器
server.listen(PORT, () => {
  logger.info(`API Gateway started on port ${PORT}`);
  console.log(`🚀 AI API Gateway running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server running on ws://localhost:${PORT}/ws`);
});

// 初始化 WebSocket 服务器
const wss = new WebSocketServerImpl(server);

// 设置 WebSocket 服务器引用到 logger
setWebSocketServer(wss);

// 导出 wss 供路由使用
export { wss, server };

export default app;
