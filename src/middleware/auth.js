import winston from 'winston';
import { verifyToken, verifyApiKey } from '../services/authService.js';

const logger = winston.createLogger();

/**
 * 认证中间件 - 支持 JWT Token 和 API Key 认证
 */
export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  // 优先使用 API Key 认证
  if (apiKeyHeader) {
    try {
      const apiKeyData = await verifyApiKey(apiKeyHeader);

      if (!apiKeyData) {
        return res.status(401).json({
          error: {
            message: 'Invalid or revoked API Key',
            type: 'authentication_error'
          }
        });
      }

      // 附加 API Key 信息到请求对象
      req.apiKey = {
        id: apiKeyData.id,
        userId: apiKeyData.userId,
        rateLimitPerMinute: apiKeyData.rateLimitPerMinute,
        rateLimitPerDay: apiKeyData.rateLimitPerDay
      };

      req.user = {
        userId: apiKeyData.userId,
        email: apiKeyData.email,
        role: apiKeyData.role
      };

      logger.info('API Key authenticated', {
        userId: apiKeyData.userId,
        keyId: apiKeyData.id
      });

      return next();
    } catch (error) {
      logger.error('API Key auth error:', error.message);
      return res.status(401).json({
        error: {
          message: 'API Key authentication failed',
          type: 'authentication_error'
        }
      });
    }
  }

  // 使用 JWT Token 认证
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        message: 'Authorization header required',
        type: 'authentication_error'
      }
    });
  }

  try {
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({
        error: {
          message: 'Token expired or invalid',
          type: 'authentication_error'
        }
      });
    }

    // 附加用户信息到请求对象
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role
    };

    logger.info('JWT authenticated', { userId: decoded.userId });
    next();
  } catch (error) {
    logger.error('JWT auth error:', error.message);
    res.status(401).json({
      error: {
        message: 'Token authentication failed',
        type: 'authentication_error'
      }
    });
  }
};

/**
 * 可选认证 - 如果有 token 则认证，没有也不强制
 */
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  if (apiKeyHeader) {
    try {
      const apiKeyData = await verifyApiKey(apiKeyHeader);
      if (apiKeyData) {
        req.apiKey = { id: apiKeyData.id, userId: apiKeyData.userId };
        req.user = { userId: apiKeyData.userId, email: apiKeyData.email, role: apiKeyData.role };
      }
    } catch (error) {
      // 忽略错误，继续
    }
  }

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      if (decoded) {
        req.user = { userId: decoded.userId, email: decoded.email, role: decoded.role };
      }
    } catch (error) {
      // 忽略错误，继续
    }
  }

  next();
};

/**
 * 管理员认证 - 只允许 admin 角色
 */
export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      error: {
        message: 'Admin access required',
        type: 'authorization_error'
      }
    });
  }
  next();
};
