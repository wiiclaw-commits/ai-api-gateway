/**
 * Redis 客户端 - 用于分布式速率限制和会话存储
 */
import Redis from 'ioredis';
import winston from 'winston';

const logger = winston.createLogger();

// Redis 配置
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0'),
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis retry limit exceeded, using fallback');
      return null; // 停止重试，使用 fallback
    }
    return Math.min(times * 100, 3000);
  },
  lazyConnect: true
};

let redisClient = null;

/**
 * 获取 Redis 客户端（单例模式）
 */
export const getRedisClient = async () => {
  if (!redisClient) {
    redisClient = new Redis(redisConfig);

    redisClient.on('error', (err) => {
      logger.warn('Redis error, using fallback:', err.message);
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected', { host: redisConfig.host, port: redisConfig.port });
    });

    try {
      await redisClient.connect();
      logger.info('Redis client initialized');
    } catch (error) {
      logger.warn('Failed to connect to Redis, using in-memory fallback');
      redisClient = null;
    }
  }

  return redisClient;
};

// 内存存储作为 fallback
const memoryStore = new Map();

/**
 * Redis/内存 速率限制检查（滑动窗口）
 */
export const checkRateLimitRedis = async (key, limit, windowSeconds) => {
  const client = await getRedisClient();
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  if (!client) {
    // 内存 fallback
    return checkRateLimitMemory(key, limit, windowSeconds);
  }

  try {
    const pipeline = client.pipeline();

    // 移除窗口外的记录
    pipeline.zremrangebyscore(key, 0, windowStart);

    // 添加当前请求
    pipeline.zadd(key, now, `${now}-${Math.random()}`);

    // 设置过期时间
    pipeline.expire(key, windowSeconds * 2);

    // 获取当前窗口内的请求数
    pipeline.zcard(key);

    const results = await pipeline.exec();
    const count = results[3][1];

    return {
      allowed: count <= limit,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetAfter: windowSeconds * 1000
    };
  } catch (error) {
    logger.error('Redis rate limit error:', error.message);
    return checkRateLimitMemory(key, limit, windowSeconds);
  }
};

/**
 * 内存速率限制检查（fallback）
 */
const checkRateLimitMemory = (key, limit, windowSeconds) => {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  // 获取或创建窗口
  if (!memoryStore.has(key)) {
    memoryStore.set(key, []);
  }

  const requests = memoryStore.get(key);

  // 移除窗口外的记录
  const validRequests = requests.filter(timestamp => timestamp > windowStart);

  // 添加当前请求
  validRequests.push(now);
  memoryStore.set(key, validRequests);

  return {
    allowed: validRequests.length <= limit,
    count: validRequests.length,
    limit,
    remaining: Math.max(0, limit - validRequests.length),
    resetAfter: windowSeconds * 1000
  };
};

/**
 * 存储会话到 Redis
 */
export const setSession = async (sessionId, data, ttlSeconds) => {
  const client = await getRedisClient();

  if (!client) {
    memoryStore.set(`session:${sessionId}`, { ...data, expires: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  try {
    await client.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
    return true;
  } catch (error) {
    logger.error('Set session error:', error.message);
    memoryStore.set(`session:${sessionId}`, { ...data, expires: Date.now() + ttlSeconds * 1000 });
    return false;
  }
};

/**
 * 从 Redis 获取会话
 */
export const getSession = async (sessionId) => {
  const client = await getRedisClient();

  if (!client) {
    const session = memoryStore.get(`session:${sessionId}`);
    if (session && session.expires > Date.now()) {
      return session;
    }
    memoryStore.delete(`session:${sessionId}`);
    return null;
  }

  try {
    const data = await client.get(`session:${sessionId}`);
    if (!data) return null;
    return JSON.parse(data);
  } catch (error) {
    logger.error('Get session error:', error.message);
    const session = memoryStore.get(`session:${sessionId}`);
    if (session && session.expires > Date.now()) {
      return session;
    }
    return null;
  }
};

/**
 * 删除会话
 */
export const deleteSession = async (sessionId) => {
  const client = await getRedisClient();

  memoryStore.delete(`session:${sessionId}`);

  if (!client) return true;

  try {
    await client.del(`session:${sessionId}`);
    return true;
  } catch (error) {
    logger.error('Delete session error:', error.message);
    return false;
  }
};

export default {
  getRedisClient,
  checkRateLimitRedis,
  setSession,
  getSession,
  deleteSession
};
