import winston from 'winston';

const logger = winston.createLogger();

// 支持的 AI 提供商和模型列表
const availableModels = [
  // OpenAI
  {
    id: 'openai/gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    context_window: 8192,
    pricing: { prompt: 0.03, completion: 0.06 }
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai',
    context_window: 128000,
    pricing: { prompt: 0.01, completion: 0.03 }
  },
  {
    id: 'openai/gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'openai',
    context_window: 16385,
    pricing: { prompt: 0.0005, completion: 0.0015 }
  },

  // Anthropic
  {
    id: 'anthropic/claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    context_window: 200000,
    pricing: { prompt: 0.015, completion: 0.075 }
  },
  {
    id: 'anthropic/claude-3-sonnet-20240229',
    name: 'Claude 3 Sonnet',
    provider: 'anthropic',
    context_window: 200000,
    pricing: { prompt: 0.003, completion: 0.015 }
  },
  {
    id: 'anthropic/claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    provider: 'anthropic',
    context_window: 200000,
    pricing: { prompt: 0.00025, completion: 0.00125 }
  },

  // 阿里云百炼
  {
    id: 'bailian/qwen3.5-plus',
    name: 'Qwen3.5 Plus',
    provider: 'bailian',
    context_window: 1000000,
    pricing: { prompt: 0, completion: 0 }
  },
  {
    id: 'bailian/qwen3-max-2026-01-23',
    name: 'Qwen3 Max',
    provider: 'bailian',
    context_window: 262144,
    pricing: { prompt: 0, completion: 0 }
  },
  {
    id: 'bailian/qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    provider: 'bailian',
    context_window: 1000000,
    pricing: { prompt: 0, completion: 0 }
  },

  // DeepSeek
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    context_window: 128000,
    pricing: { prompt: 0.00014, completion: 0.00028 }
  },
  {
    id: 'deepseek/deepseek-coder',
    name: 'DeepSeek Coder',
    provider: 'deepseek',
    context_window: 128000,
    pricing: { prompt: 0.00014, completion: 0.00028 }
  }
];

/**
 * 获取所有可用模型列表
 */
export const listModels = async (req, res) => {
  try {
    const { provider } = req.query;

    let models = availableModels;
    if (provider) {
      models = models.filter(m => m.provider === provider);
    }

    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Date.now(),
        owned_by: m.provider,
        name: m.name,
        context_window: m.context_window,
        pricing: m.pricing
      }))
    });
  } catch (error) {
    logger.error('List models error:', error);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
};

/**
 * 获取单个模型详情
 */
export const getModel = async (req, res) => {
  try {
    const { modelId } = req.params;
    const model = availableModels.find(m => m.id === modelId);

    if (!model) {
      return res.status(404).json({
        error: {
          message: 'Model not found',
          type: 'not_found'
        }
      });
    }

    res.json({
      id: model.id,
      object: 'model',
      created: Date.now(),
      owned_by: model.provider,
      name: model.name,
      context_window: model.context_window,
      pricing: model.pricing
    });
  } catch (error) {
    logger.error('Get model error:', error);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
};
