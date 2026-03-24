-- OpenClaw Dev 生产环境数据库初始化脚本
-- PostgreSQL Schema

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 用户表
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'service')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),

    -- 计费相关
    balance DECIMAL(20, 6) DEFAULT 0.000000,
    monthly_quota DECIMAL(20, 6) DEFAULT 0.000000,
    monthly_usage DECIMAL(20, 6) DEFAULT 0.000000,

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
);

-- 用户表索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ============================================
-- 会话表
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(512) UNIQUE NOT NULL,

    -- 会话信息
    ip_address INET,
    user_agent TEXT,

    -- 过期时间
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 会话表索引
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================
-- API 密钥表
-- ============================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 密钥信息（存储 hash）
    key_hash VARCHAR(64) UNIQUE NOT NULL,
    key_prefix VARCHAR(20) NOT NULL, -- 用于显示，如 "sk-abc123"
    name VARCHAR(100) DEFAULT 'Default Key',

    -- 权限配置
    permissions JSONB DEFAULT '{"models": [], "max_tokens": null}',

    -- 限流配置
    rate_limit_per_minute INTEGER DEFAULT 60,
    rate_limit_per_day INTEGER DEFAULT 10000,
    daily_quota DECIMAL(20, 6) DEFAULT 0.000000,
    daily_usage DECIMAL(20, 6) DEFAULT 0.000000,

    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
    expires_at TIMESTAMP WITH TIME ZONE,

    -- 时间戳
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- API 密钥表索引
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);

-- ============================================
-- 使用日志表
-- ============================================
CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- 关联
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    -- 请求信息
    model VARCHAR(100) NOT NULL,
    endpoint VARCHAR(255),

    -- Token 使用
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,

    -- 费用计算
    cost DECIMAL(20, 6) DEFAULT 0.000000,

    -- 请求结果
    status_code INTEGER,
    error_message TEXT,
    duration_ms INTEGER,

    -- 元数据
    request_id VARCHAR(100),
    ip_address INET,

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 使用日志表索引
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_api_key_id ON usage_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs(model);

-- ============================================
-- 计费表
-- ============================================
CREATE TABLE IF NOT EXISTS billing (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 余额
    balance DECIMAL(20, 6) DEFAULT 0.000000,
    currency VARCHAR(3) DEFAULT 'CNY',

    -- 月度统计
    monthly_quota DECIMAL(20, 6) DEFAULT 0.000000,
    monthly_usage DECIMAL(20, 6) DEFAULT 0.000000,
    billing_cycle_start DATE,
    billing_cycle_end DATE,

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 计费表索引
CREATE INDEX IF NOT EXISTS idx_billing_user_id ON billing(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_user_unique ON billing(user_id);

-- ============================================
-- 支付记录表
-- ============================================
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 支付信息
    amount DECIMAL(20, 6) NOT NULL,
    currency VARCHAR(3) DEFAULT 'CNY',
    provider VARCHAR(50) DEFAULT 'stripe', -- stripe, alipay, wechat
    provider_payment_id VARCHAR(255),

    -- 状态
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 支付记录表索引
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_id ON payments(provider_payment_id);

-- ============================================
-- 速率限制表 (Redis 备用，用于分布式限流)
-- ============================================
CREATE TABLE IF NOT EXISTS rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- 限流维度
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE,
    ip_address INET,

    -- 限流类型
    limit_type VARCHAR(50) NOT NULL, -- 'per_minute', 'per_hour', 'per_day'

    -- 计数
    request_count INTEGER DEFAULT 0,
    token_count DECIMAL(20, 6) DEFAULT 0.000000,

    -- 时间窗口
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    window_end TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 速率限制表索引
CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(user_id, limit_type, window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_api_key ON rate_limits(api_key_id, limit_type, window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip_address, limit_type, window_start);

-- ============================================
-- 模型定价表
-- ============================================
CREATE TABLE IF NOT EXISTS model_pricing (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    model_id VARCHAR(100) UNIQUE NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL,

    -- 价格（每 1000 tokens）
    input_price DECIMAL(20, 6) DEFAULT 0.000000,
    output_price DECIMAL(20, 6) DEFAULT 0.000000,

    -- 状态
    status VARCHAR(20) DEFAULT 'active',

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 触发器：自动更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_billing_updated_at BEFORE UPDATE ON billing
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 模型定价初始数据
-- ============================================
INSERT INTO model_pricing (model_id, model_name, provider, input_price, output_price) VALUES
    ('qwen3.5-plus', 'Qwen 3.5 Plus', 'aliyun', 0.004000, 0.012000),
    ('qwen3-coder-plus', 'Qwen 3 Coder Plus', 'aliyun', 0.004000, 0.012000),
    ('qwen3-coder-next', 'Qwen 3 Coder Next', 'aliyun', 0.002000, 0.006000),
    ('kimi-k2.5', 'Kimi K2.5', 'moonshot', 0.004000, 0.012000),
    ('gpt-4', 'GPT-4', 'openai', 0.030000, 0.060000),
    ('gpt-3.5-turbo', 'GPT-3.5 Turbo', 'openai', 0.000500, 0.001500),
    ('claude-3-opus', 'Claude 3 Opus', 'anthropic', 0.015000, 0.075000),
    ('claude-3-sonnet', 'Claude 3 Sonnet', 'anthropic', 0.003000, 0.015000)
ON CONFLICT (model_id) DO NOTHING;

-- ============================================
-- 视图：用户使用情况统计
-- ============================================
CREATE OR REPLACE VIEW user_usage_stats AS
SELECT
    u.id as user_id,
    u.email,
    u.balance,
    u.monthly_quota,
    u.monthly_usage,
    COUNT(DISTINCT ak.id) as api_key_count,
    COALESCE(SUM(ul.total_tokens), 0) as total_tokens_used,
    COALESCE(SUM(ul.cost), 0) as total_cost,
    MAX(ul.created_at) as last_request_at
FROM users u
LEFT JOIN api_keys ak ON u.id = ak.user_id AND ak.status = 'active'
LEFT JOIN usage_logs ul ON u.id = ul.user_id
WHERE u.status = 'active'
GROUP BY u.id, u.email, u.balance, u.monthly_quota, u.monthly_usage;

-- ============================================
-- 注释说明
-- ============================================
COMMENT ON TABLE users IS '用户表 - 存储用户账户信息';
COMMENT ON TABLE sessions IS '会话表 - 存储用户登录会话';
COMMENT ON TABLE api_keys IS 'API 密钥表 - 存储 API Key 及其权限配置';
COMMENT ON TABLE usage_logs IS '使用日志表 - 记录所有 API 调用';
COMMENT ON TABLE billing IS '计费表 - 存储用户余额和账单信息';
COMMENT ON TABLE payments IS '支付记录表 - 存储充值支付记录';
COMMENT ON TABLE rate_limits IS '速率限制表 - 分布式限流备用存储';
COMMENT ON TABLE model_pricing IS '模型定价表 - 存储各模型的价格信息';
