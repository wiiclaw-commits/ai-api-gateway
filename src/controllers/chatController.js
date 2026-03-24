import axios from 'axios';
import winston from 'winston';
import dotenv from 'dotenv';
import { rateLimitMiddleware, checkRateLimit } from '../services/rateLimitService.js';
import { recordUsage } from '../services/authService.js';
import { query } from '../database/index.js';

dotenv.config();

const logger = winston.createLogger();

// 支持的 AI 提供商配置
const providers = {
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo']
  },
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
    apiKey: process.env.ANTHROPIC_API_KEY,
    models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307']
  },
  bailian: {
    baseUrl: process.env.BAILIAN_BASE_URL || 'https://coding.dashscope.aliyuncs.com/v1',
    apiKey: process.env.BAILIAN_API_KEY,
    models: ['qwen3.5-plus', 'qwen3-max-2026-01-23', 'qwen3-coder-plus']
  },
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    models: ['deepseek-chat', 'deepseek-coder']
  }
};

/**
 * 处理聊天完成请求
 * 支持多模型路由和负载均衡
 */
export const chatCompletion = async (req, res) => {
  const startTime = Date.now();

  try {
    const { model, messages, temperature = 0.7, max_tokens, stream = false } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameters: model, messages',
          type: 'invalid_request_error'
        }
      });
    }

    // 速率限制检查
    const apiKeyId = req.apiKey?.id;
    const userId = req.user?.userId;
    const ipAddress = req.ip || req.connection?.remoteAddress;

    const rateLimitResult = await checkRateLimit({
      userId,
      apiKeyId,
      ipAddress,
      window: 'perMinute'
    });

    if (!rateLimitResult.allowed) {
      const exceeded = rateLimitResult.limits.find(l => l.remaining <= 0);
      res.setHeader('Retry-After', rateLimitResult.retryAfter);

      return res.status(429).json({
        error: {
          message: 'Rate limit exceeded. Please try again later.',
          type: 'rate_limit_error',
          details: {
            limit: exceeded?.limit,
            remaining: 0,
            retryAfter: rateLimitResult.retryAfter
          }
        }
      });
    }

    // 设置限流响应头
    const minuteLimit = rateLimitResult.limits.find(l => l.type === 'api_key' || l.type === 'user');
    if (minuteLimit) {
      res.setHeader('X-RateLimit-Limit', minuteLimit.limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, minuteLimit.remaining));
      res.setHeader('X-RateLimit-Reset', Date.now() + rateLimitResult.resetAfter);
    }

    // 根据 model 选择 provider
    const [providerName, modelName] = parseModelId(model);
    const provider = providers[providerName];

    if (!provider) {
      return res.status(400).json({
        error: {
          message: `Unknown provider: ${providerName}`,
          type: 'invalid_request_error'
        }
      });
    }

    if (!provider.apiKey) {
      return res.status(503).json({
        error: {
          message: `Provider ${providerName} not configured`,
          type: 'provider_error'
        }
      });
    }

    // 调用 provider API
    const response = await callProvider(provider, modelName, {
      messages,
      temperature,
      max_tokens,
      stream
    });

    const duration = Date.now() - startTime;

    // 计算费用并记录使用量
    const usage = response.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

    // 获取模型定价并计算费用
    const cost = await calculateCost(providerName, modelName, inputTokens, outputTokens);

    // 记录使用日志
    if (userId) {
      await recordUsage({
        userId,
        apiKeyId,
        model: `${providerName}/${modelName}`,
        endpoint: '/api/v1/chat/completions',
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        statusCode: 200,
        errorMessage: null,
        durationMs: duration,
        requestId: response.id || `req-${Date.now()}`,
        ipAddress
      });
    }

    res.json(formatResponse(response, providerName, modelName));

  } catch (error) {
    logger.error('Chat completion error:', error);

    // 记录错误日志
    const userId = req.user?.userId;
    const apiKeyId = req.apiKey?.id;
    const ipAddress = req.ip || req.connection?.remoteAddress;

    if (userId) {
      await recordUsage({
        userId,
        apiKeyId,
        model: req.body?.model || 'unknown',
        endpoint: '/api/v1/chat/completions',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        statusCode: error.response?.status || 500,
        errorMessage: error.message,
        durationMs: Date.now() - startTime,
        requestId: `req-${Date.now()}`,
        ipAddress
      }).catch(() => {}); // 忽略记录错误
    }

    res.status(500).json({
      error: {
        message: error.message || 'Internal error',
        type: 'server_error'
      }
    });
  }
};

function parseModelId(modelId) {
  // 支持格式：provider/model-name 或 model-name
  const parts = modelId.split('/');
  if (parts.length === 2) {
    return [parts[0], parts[1]];
  }
  // 默认使用 bailian
  return ['bailian', modelId];
}

async function callProvider(provider, model, options) {
  const url = `${provider.baseUrl}/chat/completions`;

  const response = await axios.post(url, {
    model,
    messages: options.messages,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
    stream: options.stream
  }, {
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

function formatResponse(response, provider, model) {
  return {
    id: response.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${provider}/${model}`,
    choices: response.choices,
    usage: response.usage
  };
}

/**
 * 计算 API 调用费用
 * @param {string} provider - 提供商名称
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 * @returns {Promise<number>} - 费用（元）
 */
async function calculateCost(provider, model, inputTokens, outputTokens) {
  try {
    // 从数据库获取模型定价
    const result = await query(
      `SELECT input_price, output_price FROM model_pricing
       WHERE model_id = $1 AND status = 'active'`,
      [model]
    );

    if (result.rows.length > 0) {
      const pricing = result.rows[0];
      const inputCost = (inputTokens / 1000) * parseFloat(pricing.input_price);
      const outputCost = (outputTokens / 1000) * parseFloat(pricing.output_price);
      return inputCost + outputCost;
    }

    // 默认价格（如果没有配置）
    const defaultInputPrice = 0.004; // 每 1000 tokens
    const defaultOutputPrice = 0.012;
    return (inputTokens / 1000) * defaultInputPrice + (outputTokens / 1000) * defaultOutputPrice;
  } catch (error) {
    logger.error('Failed to calculate cost:', error.message);
    return 0;
  }
}
