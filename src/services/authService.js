/**
 * 用户认证服务
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query, getClient } from '../database/index.js';

// 从环境变量加载配置
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// 验证配置是否正确加载
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET not set in environment variables, using default!');
}

/**
 * 密码哈希
 */
export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
};

/**
 * 验证密码
 */
export const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

/**
 * 生成 JWT Token
 */
export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

/**
 * 验证 JWT Token
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
};

/**
 * 生成 API Key
 */
export const generateApiKey = () => {
  // 生成 sk- 开头的 API Key
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const key = `sk-${randomBytes}`;
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const keyPrefix = key.substring(0, 12);

  return {
    key,
    keyHash,
    keyPrefix
  };
};

/**
 * 验证 API Key
 */
export const verifyApiKey = async (key) => {
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const keyPrefix = key.substring(0, 12);

  // API Key 格式：sk- + 64 个 hex 字符 = 67 个字符
  if (!key.startsWith('sk-') || key.length !== 67) {
    return null;
  }

  const result = await query(
    `SELECT ak.*, u.email, u.role, u.status as user_status,
            bl.balance, bl.monthly_quota, bl.monthly_usage
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     LEFT JOIN billing bl ON u.id = bl.user_id
     WHERE ak.key_hash = $1 AND ak.status = 'active'`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const apiKey = result.rows[0];

  // 检查是否过期
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    return null;
  }

  // 检查用户状态
  if (apiKey.user_status !== 'active') {
    return null;
  }

  // 更新最后使用时间
  await query(
    'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
    [apiKey.id]
  );

  return {
    id: apiKey.id,
    userId: apiKey.user_id,
    email: apiKey.email,
    role: apiKey.role,
    permissions: apiKey.permissions,
    rateLimitPerMinute: apiKey.rate_limit_per_minute,
    rateLimitPerDay: apiKey.rate_limit_per_day,
    dailyQuota: apiKey.daily_quota,
    dailyUsage: apiKey.daily_usage,
    balance: apiKey.balance,
    monthlyQuota: apiKey.monthly_quota,
    monthlyUsage: apiKey.monthly_usage
  };
};

/**
 * 创建用户
 */
export const createUser = async (userData) => {
  const { email, password, name } = userData;

  // 检查邮箱是否已存在
  const existing = await query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existing.rows.length > 0) {
    throw new Error('Email already registered');
  }

  // 哈希密码
  const passwordHash = await hashPassword(password);

  // 创建用户
  const result = await query(
    `INSERT INTO users (email, password_hash, name, balance)
     VALUES ($1, $2, $3, 100.000000)
     RETURNING id, email, name, role, status, created_at`,
    [email, passwordHash, name || email.split('@')[0]]
  );

  const user = result.rows[0];

  // 创建默认计费记录
  await query(
    `INSERT INTO billing (user_id, balance, monthly_quota, billing_cycle_start, billing_cycle_end)
     VALUES ($1, 100.000000, 1000.000000, CURRENT_DATE, (CURRENT_DATE + INTERVAL '1 month')::date)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  return user;
};

/**
 * 用户登录
 */
export const loginUser = async (email, password) => {
  // 查找用户
  const result = await query(
    'SELECT id, email, password_hash, name, role, status FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const user = result.rows[0];

  // 验证密码
  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    throw new Error('Invalid email or password');
  }

  // 检查用户状态
  if (user.status !== 'active') {
    throw new Error('Account is suspended');
  }

  // 生成 JWT
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role
  });

  // 创建会话记录
  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [user.id, token]
  );

  // 更新最后登录时间
  await query(
    'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
    [user.id]
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    },
    token,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  };
};

/**
 * 用户登出
 */
export const logoutUser = async (token) => {
  await query(
    'DELETE FROM sessions WHERE token = $1',
    [token]
  );
};

/**
 * 获取用户信息
 */
export const getUserById = async (userId) => {
  const result = await query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.balance,
            u.monthly_quota, u.monthly_usage, u.created_at,
            bl.balance as billing_balance, bl.monthly_quota as billing_quota
     FROM users u
     LEFT JOIN billing bl ON u.id = bl.user_id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
};

/**
 * 创建 API Key
 */
export const createApiKey = async (userId, options = {}) => {
  const { name = 'Default Key', permissions = {}, rateLimitPerMinute = 60, rateLimitPerDay = 10000 } = options;

  // 生成 API Key
  const { key, keyHash, keyPrefix } = generateApiKey();

  // 创建记录
  const result = await query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, permissions,
                          rate_limit_per_minute, rate_limit_per_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, key_prefix, name, permissions, rate_limit_per_minute,
               rate_limit_per_day, created_at`,
    [userId, keyHash, keyPrefix, name, JSON.stringify(permissions), rateLimitPerMinute, rateLimitPerDay]
  );

  return {
    ...result.rows[0],
    key // 只在创建时返回完整 key
  };
};

/**
 * 获取用户 API Key 列表
 */
export const getUserApiKeys = async (userId) => {
  const result = await query(
    `SELECT id, key_prefix, name, permissions, rate_limit_per_minute,
            rate_limit_per_day, status, last_used_at, created_at, expires_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
};

/**
 * 撤销 API Key
 */
export const revokeApiKey = async (userId, keyId) => {
  const result = await query(
    `UPDATE api_keys SET status = 'revoked'
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [keyId, userId]
  );

  return result.rows.length > 0;
};

/**
 * 记录 API 使用
 */
export const recordUsage = async (usageData) => {
  const {
    userId,
    apiKeyId,
    model,
    endpoint,
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
    statusCode,
    errorMessage,
    durationMs,
    requestId,
    ipAddress
  } = usageData;

  await query(
    `INSERT INTO usage_logs (user_id, api_key_id, model, endpoint,
                            input_tokens, output_tokens, total_tokens, cost,
                            status_code, error_message, duration_ms, request_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [userId, apiKeyId, model, endpoint, inputTokens, outputTokens, totalTokens,
     cost, statusCode, errorMessage, durationMs, requestId, ipAddress]
  );

  // 更新用户月度使用
  await query(
    `UPDATE users SET monthly_usage = monthly_usage + $1 WHERE id = $2`,
    [cost, userId]
  );

  // 更新 API Key 每日使用
  if (apiKeyId) {
    await query(
      `UPDATE api_keys SET daily_usage = daily_usage + $1
       WHERE id = $2 AND (daily_usage + $1) <= daily_quota`,
      [cost, apiKeyId]
    );
  }

  // 扣除用户余额（如果有 billing 记录）
  if (cost > 0) {
    await query(
      `UPDATE billing SET balance = balance - $1 WHERE user_id = $2`,
      [cost, userId]
    );
  }
};

/**
 * 获取使用统计
 */
export const getUsageStats = async (userId, days = 30) => {
  const result = await query(
    `SELECT
        DATE(created_at) as date,
        COUNT(*) as request_count,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as total_cost,
        COUNT(DISTINCT model) as models_used
     FROM usage_logs
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [userId]
  );

  return result.rows;
};

/**
 * 创建支付记录
 */
export const createPayment = async (userId, paymentData) => {
  const { amount, currency = 'CNY', provider = 'stripe' } = paymentData;

  const result = await query(
    `INSERT INTO payments (user_id, amount, currency, provider, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id, user_id, amount, currency, provider, status, created_at`,
    [userId, amount, currency, provider]
  );

  return result.rows[0];
};

/**
 * 完成支付并增加余额
 */
export const completePayment = async (userId, paymentId, providerPaymentId) => {
  const client = await getClient();

  try {
    await client.beginTransaction();

    // 更新支付记录
    const paymentResult = await client.query(
      `UPDATE payments
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP, provider_payment_id = $1
       WHERE id = $2 AND user_id = $3
       RETURNING amount`,
      [providerPaymentId, paymentId, userId]
    );

    if (paymentResult.rows.length === 0) {
      throw new Error('Payment not found');
    }

    const amount = parseFloat(paymentResult.rows[0].amount);

    // 更新用户余额
    await client.query(
      `UPDATE billing SET balance = balance + $1 WHERE user_id = $2`,
      [amount, userId]
    );

    // 更新 users 表余额
    await client.query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2`,
      [amount, userId]
    );

    await client.commit();

    return { success: true, amount };
  } catch (error) {
    await client.rollback();
    throw error;
  }
};

/**
 * 获取支付历史
 */
export const getPaymentHistory = async (userId, limit = 10) => {
  const result = await query(
    `SELECT id, amount, currency, provider, status, created_at, completed_at
     FROM payments
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
};

export default {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateApiKey,
  verifyApiKey,
  createUser,
  loginUser,
  logoutUser,
  getUserById,
  createApiKey,
  getUserApiKeys,
  revokeApiKey,
  recordUsage,
  getUsageStats,
  createPayment,
  completePayment,
  getPaymentHistory
};
