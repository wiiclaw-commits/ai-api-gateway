/**
 * 认证路由 - 用户注册、登录、API Key 管理
 */
import { Router } from 'express';
import authService from '../services/authService.js';
import { rateLimitMiddleware } from '../services/rateLimitService.js';
import { mainLogger } from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const router = Router();

/**
 * POST /api/v1/auth/register
 * 用户注册
 */
router.post('/register', rateLimitMiddleware, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // 验证输入
    if (!email || !password) {
      return res.status(400).json({
        error: {
          message: 'Email and password are required',
          type: 'invalid_request_error'
        }
      });
    }

    // 邮箱格式验证
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: {
          message: 'Invalid email format',
          type: 'invalid_request_error'
        }
      });
    }

    // 密码强度验证
    if (password.length < 8) {
      return res.status(400).json({
        error: {
          message: 'Password must be at least 8 characters',
          type: 'invalid_request_error'
        }
      });
    }

    // 创建用户
    const user = await authService.createUser({ email, password, name });

    mainLogger.info('New user registered', { userId: user.id, email: user.email });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    mainLogger.error('Registration failed:', error.message);

    if (error.message === 'Email already registered') {
      return res.status(409).json({
        error: {
          message: 'Email already registered',
          type: 'conflict_error'
        }
      });
    }

    res.status(500).json({
      error: {
        message: error.message || 'Registration failed',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/auth/login
 * 用户登录
 */
router.post('/login', rateLimitMiddleware, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: {
          message: 'Email and password are required',
          type: 'invalid_request_error'
        }
      });
    }

    const result = await authService.loginUser(email, password);

    mainLogger.info('User logged in', { userId: result.user.id, email: result.user.email });

    res.json({
      success: true,
      user: result.user,
      token: result.token,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    mainLogger.error('Login failed:', error.message);

    if (error.message === 'Invalid email or password' || error.message === 'Account is suspended') {
      return res.status(401).json({
        error: {
          message: error.message,
          type: 'authentication_error'
        }
      });
    }

    res.status(500).json({
      error: {
        message: error.message || 'Login failed',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * 用户登出
 */
router.post('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await authService.logoutUser(token);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    mainLogger.error('Logout failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Logout failed',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/auth/me
 * 获取当前用户信息
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error'
        }
      });
    }

    const user = await authService.getUserById(userId);

    res.json({
      success: true,
      user
    });
  } catch (error) {
    mainLogger.error('Get user failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get user',
        type: 'server_error'
      }
    });
  }
});

/**
 * =====================
 *  API Key 管理
 * =====================
 */

/**
 * POST /api/v1/auth/api-keys
 * 创建新的 API Key
 */
router.post('/api-keys', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error'
        }
      });
    }

    const { name, permissions, rateLimitPerMinute, rateLimitPerDay } = req.body;

    const apiKey = await authService.createApiKey(userId, {
      name,
      permissions,
      rateLimitPerMinute,
      rateLimitPerDay
    });

    mainLogger.info('API Key created', { userId, keyId: apiKey.id });

    res.status(201).json({
      success: true,
      apiKey: {
        id: apiKey.id,
        key: apiKey.key, // 只在创建时返回
        keyPrefix: apiKey.keyPrefix,
        name: apiKey.name,
        permissions: apiKey.permissions,
        rateLimitPerMinute: apiKey.rateLimitPerMinute,
        rateLimitPerDay: apiKey.rateLimitPerDay,
        createdAt: apiKey.created_at
      }
    });
  } catch (error) {
    mainLogger.error('Create API Key failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create API Key',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/auth/api-keys
 * 获取用户的 API Key 列表
 */
router.get('/api-keys', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error'
        }
      });
    }

    const apiKeys = await authService.getUserApiKeys(userId);

    res.json({
      success: true,
      apiKeys
    });
  } catch (error) {
    mainLogger.error('Get API Keys failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get API Keys',
        type: 'server_error'
      }
    });
  }
});

/**
 * DELETE /api/v1/auth/api-keys/:id
 * 撤销 API Key
 */
router.delete('/api-keys/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error'
        }
      });
    }

    const revoked = await authService.revokeApiKey(userId, id);

    if (!revoked) {
      return res.status(404).json({
        error: {
          message: 'API Key not found',
          type: 'not_found_error'
        }
      });
    }

    mainLogger.info('API Key revoked', { userId, keyId: id });

    res.json({
      success: true,
      message: 'API Key revoked successfully'
    });
  } catch (error) {
    mainLogger.error('Revoke API Key failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to revoke API Key',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/auth/usage
 * 获取使用统计
 */
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { days = 30 } = req.query;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error'
        }
      });
    }

    const stats = await authService.getUsageStats(userId, parseInt(days));

    res.json({
      success: true,
      stats,
      period: {
        days: parseInt(days),
        start: new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString()
      }
    });
  } catch (error) {
    mainLogger.error('Get usage stats failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get usage stats',
        type: 'server_error'
      }
    });
  }
});

/**
 * =====================
 *  支付管理
 * =====================
 */

/**
 * POST /api/v1/auth/payments
 * 创建支付记录
 */
router.post('/payments', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { amount, currency = 'CNY', provider = 'stripe' } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: {
          message: 'Invalid amount',
          type: 'invalid_request_error'
        }
      });
    }

    const payment = await authService.createPayment(userId, { amount, currency, provider });

    mainLogger.info('Payment created', { userId, paymentId: payment.id, amount });

    res.status(201).json({
      success: true,
      payment
    });
  } catch (error) {
    mainLogger.error('Create payment failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create payment',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/auth/payments/:id/complete
 * 完成支付（模拟，实际应使用 webhook）
 */
router.post('/payments/:id/complete', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { providerPaymentId } = req.body;

    const result = await authService.completePayment(userId, id, providerPaymentId || `pay_${Date.now()}`);

    mainLogger.info('Payment completed', { userId, paymentId: id, amount: result.amount });

    res.json({
      success: true,
      message: 'Payment completed successfully',
      amount: result.amount
    });
  } catch (error) {
    mainLogger.error('Complete payment failed:', error.message);
    res.status(400).json({
      error: {
        message: error.message || 'Failed to complete payment',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/auth/payments
 * 获取支付历史
 */
router.get('/payments', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { limit = 10 } = req.query;

    const payments = await authService.getPaymentHistory(userId, parseInt(limit));

    res.json({
      success: true,
      payments
    });
  } catch (error) {
    mainLogger.error('Get payments failed:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get payments',
        type: 'server_error'
      }
    });
  }
});

export default router;
