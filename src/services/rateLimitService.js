/**
 * 速率限制服务
 * 支持多种限流算法：令牌桶、滑动窗口
 * 支持 Redis 分布式存储和内存 fallback
 */

import { query } from '../database/index.js';
import { checkRateLimitRedis } from './redisClient.js';
import winston from 'winston';

const logger = winston.createLogger();

/**
 * 限流配置
 */
const rateLimitConfig = {
  global: { perMinute: 1000, perHour: 30000, perDay: 500000 },
  user: { perMinute: 100, perHour: 3000, perDay: 50000 },
  apiKey: { perMinute: 60, perHour: 1800, perDay: 30000 },
  ip: { perMinute: 30, perHour: 500, perDay: 5000 }
};

/**
 * 获取 API Key 限流配置
 */
const getApiKeyLimit = async (apiKeyId, window) => {
  const fieldMap = {
    perMinute: 'rate_limit_per_minute',
    perHour: 'rate_limit_per_hour',
    perDay: 'rate_limit_per_day'
  };

  try {
    const result = await query(
      `SELECT ${fieldMap[window] || 'rate_limit_per_minute'} as limit
       FROM api_keys
       WHERE id = $1`,
      [apiKeyId]
    );
    return parseInt(result.rows[0]?.limit || rateLimitConfig.apiKey[window]);
  } catch (error) {
    logger.error('Failed to get API key limit:', error.message);
    return rateLimitConfig.apiKey[window];
  }
};

/**
 * 计算重试等待时间
 */
const calculateRetryAfter = (window) => {
  const windowSeconds = window === 'perMinute' ? 60 : window === 'perHour' ? 3600 : 86400;
  return windowSeconds;
};

/**
 * 检查限流（滑动窗口算法）- 使用 Redis 或数据库
 */
export const checkRateLimit = async (options) => {
  const { userId, apiKeyId, ipAddress, window = 'perMinute' } = options;
  const windowSeconds = window === 'perMinute' ? 60 : window === 'perHour' ? 3600 : 86400;
  const limits = [];

  if (userId) {
    const userLimit = rateLimitConfig.user[window];
    const userKey = `ratelimit:user:${userId}:${window}`;
    const userResult = await checkRateLimitRedis(userKey, userLimit, windowSeconds);
    limits.push({ type: 'user', limit: userResult.limit, count: userResult.count, remaining: userResult.remaining });
  }

  if (apiKeyId) {
    const apiKeyLimit = await getApiKeyLimit(apiKeyId, window);
    const apiKeyKey = `ratelimit:apikey:${apiKeyId}:${window}`;
    const apiKeyResult = await checkRateLimitRedis(apiKeyKey, apiKeyLimit, windowSeconds);
    limits.push({ type: 'api_key', limit: apiKeyResult.limit, count: apiKeyResult.count, remaining: apiKeyResult.remaining });
  }

  if (ipAddress) {
    const ipLimit = rateLimitConfig.ip[window];
    const ipKey = `ratelimit:ip:${ipAddress}:${window}`;
    const ipResult = await checkRateLimitRedis(ipKey, ipLimit, windowSeconds);
    limits.push({ type: 'ip', limit: ipResult.limit, count: ipResult.count, remaining: ipResult.remaining });
  }

  const exceeded = limits.find(l => l.remaining <= 0);

  return {
    allowed: !exceeded,
    limits,
    resetAfter: windowSeconds * 1000,
    retryAfter: exceeded ? calculateRetryAfter(window) : 0
  };
};

/**
 * 限流中间件
 */
export const rateLimitMiddleware = async (req, res, next) => {
  try {
    const apiKeyId = req.apiKey?.id;
    const userId = req.user?.userId;
    const ipAddress = req.ip || req.connection?.remoteAddress;

    const result = await checkRateLimit({ userId, apiKeyId, ipAddress, window: 'perMinute' });

    const minuteLimit = result.limits.find(l => l.type === 'api_key' || l.type === 'user');
    if (minuteLimit) {
      res.setHeader('X-RateLimit-Limit', minuteLimit.limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, minuteLimit.remaining));
      res.setHeader('X-RateLimit-Reset', Date.now() + result.resetAfter);
    }

    if (!result.allowed) {
      const exceeded = result.limits.find(l => l.remaining <= 0);
      res.setHeader('Retry-After', result.retryAfter);
      return res.status(429).json({
        error: {
          message: 'Rate limit exceeded. Please try again later.',
          type: 'rate_limit_error',
          details: { limit: exceeded?.limit, remaining: 0, retryAfter: result.retryAfter }
        }
      });
    }

    next();
  } catch (error) {
    logger.error('Rate limit check failed:', error.message);
    next();
  }
};

/**
 * 令牌桶限流器
 */
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  consume(tokens = 1) {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, remaining: this.tokens };
    }
    const waitTime = Math.ceil((tokens - this.tokens) / this.refillRate * 1000);
    return { allowed: false, remaining: this.tokens, waitTime };
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

const bucketCache = new Map();

export const checkTokenBucket = (key, options = {}) => {
  const { capacity = 60, refillRate = 1 } = options;
  if (!bucketCache.has(key)) {
    bucketCache.set(key, new TokenBucket(capacity, refillRate));
  }
  const bucket = bucketCache.get(key);
  const result = bucket.consume(1);
  if (bucket.tokens === bucket.capacity) {
    bucketCache.delete(key);
  }
  return result;
};

export const cleanupRateLimitCache = () => {
  for (const [key, bucket] of bucketCache.entries()) {
    if (bucket.tokens === bucket.capacity) {
      bucketCache.delete(key);
    }
  }
};

setInterval(cleanupRateLimitCache, 5 * 60 * 1000);

export default {
  checkRateLimit,
  rateLimitMiddleware,
  checkTokenBucket,
  rateLimitConfig
};
