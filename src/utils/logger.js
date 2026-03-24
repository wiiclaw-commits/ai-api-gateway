import winston from 'winston';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 创建主 logger
const mainLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'combined.log') })
  ]
});

// 内存日志存储（按 Agent ID 分类）
const logStore = new Map();

// WebSocket 服务器引用（可选，用于实时推送日志）
let wssInstance = null;

/**
 * 设置 WebSocket 服务器引用
 */
export const setWebSocketServer = (wss) => {
  wssInstance = wss;
};

/**
 * 获取 Agent 专用 logger
 */
const getAgentLogger = (agentId) => {
  if (!logStore.has(agentId)) {
    logStore.set(agentId, {
      logs: [],
      logger: winston.createLogger({
        level: 'info',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} [${agentId}] ${level.toUpperCase()}: ${message}`;
          })
        ),
        transports: [
          new winston.transports.File({
            filename: path.join(LOG_DIR, `agent-${agentId}.log`),
            maxsize: 10485760, // 10MB
            maxFiles: 5
          })
        ]
      })
    });
  }
  return logStore.get(agentId);
};

/**
 * 记录 Agent 日志
 */
export const logAgentMessage = (agentId, level, message, metadata = {}) => {
  const store = getAgentLogger(agentId);

  const logEntry = {
    timestamp: Date.now(),
    level,
    message,
    agentId,
    ...metadata
  };

  // 添加到内存存储（保留最近 1000 条）
  store.logs.push(logEntry);
  if (store.logs.length > 1000) {
    store.logs.shift();
  }

  // 写入文件
  store.logger.log(level, message, metadata);

  // WebSocket 推送（如果已连接）
  if (wssInstance) {
    wssInstance.sendLogUpdate(logEntry);
  }

  return logEntry;
};

/**
 * 获取 Agent 日志列表
 */
export const getAgentLogs = (agentId, options = {}) => {
  const store = logStore.get(agentId);
  if (!store) {
    return { logs: [] };
  }

  let logs = [...store.logs];

  // 过滤
  if (options.level) {
    logs = logs.filter(log => log.level === options.level);
  }

  // 时间范围过滤
  if (options.startTime) {
    logs = logs.filter(log => log.timestamp >= options.startTime);
  }
  if (options.endTime) {
    logs = logs.filter(log => log.timestamp <= options.endTime);
  }

  // 关键字搜索
  if (options.search) {
    const searchLower = options.search.toLowerCase();
    logs = logs.filter(log => log.message.toLowerCase().includes(searchLower));
  }

  // 分页
  const limit = options.limit || 100;
  const offset = options.offset || 0;

  // 排序（默认最新的在前）
  logs.sort((a, b) => b.timestamp - a.timestamp);

  return {
    logs: logs.slice(offset, offset + limit),
    total: logs.length,
    hasMore: offset + limit < logs.length
  };
};

/**
 * 获取所有 Agent 的最近日志
 */
export const getAllLogs = (options = {}) => {
  let allLogs = [];

  for (const [agentId, store] of logStore.entries()) {
    allLogs = allLogs.concat(store.logs.map(log => ({ ...log, agentId })));
  }

  // 排序
  allLogs.sort((a, b) => b.timestamp - a.timestamp);

  // 分页
  const limit = options.limit || 100;
  const offset = options.offset || 0;

  return {
    logs: allLogs.slice(offset, offset + limit),
    total: allLogs.length,
    hasMore: offset + limit < allLogs.length
  };
};

/**
 * 清除 Agent 日志
 */
export const clearAgentLogs = (agentId) => {
  const store = logStore.get(agentId);
  if (store) {
    store.logs = [];
  }
};

export { mainLogger, logStore };
