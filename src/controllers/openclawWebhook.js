import { Router } from 'express';
import { logAgentMessage, mainLogger } from '../utils/logger.js';
import { TaskOrchestrationEngine } from '../utils/taskOrchestrator.js';

export const router = Router();

// 任务 ID 生成器
let webhookTaskIdCounter = 0;
function generateWebhookTaskId() {
  return `webhook-task-${++webhookTaskIdCounter}`;
}

// 会话 ID 生成器
function generateSessionId() {
  return `telegram-session-${Date.now()}`;
}

/**
 * 任务类型到 Agent 的映射
 */
const TASK_AGENT_MAP = {
  // 架构设计类任务
  'architecture': 'architect',
  'design': 'architect',
  'system-design': 'architect',
  'api-design': 'architect',
  'database-design': 'architect',
  '架构': 'architect',
  '设计': 'architect',

  // 前端开发类任务
  'frontend': 'frontend',
  'ui': 'frontend',
  'jsx': 'frontend',
  'react': 'frontend',
  'vue': 'frontend',
  'css': 'frontend',
  'html': 'frontend',
  'component': 'frontend',
  '页面': 'frontend',
  '界面': 'frontend',
  '前端': 'frontend',
  '登录页': 'frontend',
  '登录页面': 'frontend',

  // 后端开发类任务
  'backend': 'backend',
  'api': 'backend',
  'node': 'backend',
  'express': 'backend',
  'database': 'backend',
  'sql': 'backend',
  'model': 'backend',
  'service': 'backend',
  'controller': 'backend',
  '后端': 'backend',
  '接口': 'backend',

  // DevOps 类任务
  'devops': 'devops',
  'deploy': 'devops',
  'docker': 'devops',
  'kubernetes': 'devops',
  'ci': 'devops',
  'cd': 'devops',
  'pipeline': 'devops',
  'infrastructure': 'devops',
  'cloud': 'devops',
  '部署': 'devops',
  '容器': 'devops',

  // 测试类任务
  'test': 'test',
  'testing': 'test',
  'unit-test': 'test',
  'integration-test': 'test',
  'e2e-test': 'test',
  'bug': 'test',
  'debug': 'test',
  '测试': 'test',
  '调试': 'test',

  // 运营类任务
  'ops': 'ops',
  'operation': 'ops',
  'doc': 'ops',
  'docs': 'ops',
  'documentation': 'ops',
  'content': 'ops',
  'marketing': 'ops',
  'seo': 'ops',
  '文档': 'ops',
  '运营': 'ops'
};

/**
 * 关键词到任务类型的映射
 */
const KEYWORD_TASK_TYPE_MAP = {
  '架构': 'design',
  '设计': 'design',
  '前端': 'frontend',
  '界面': 'frontend',
  '组件': 'frontend',
  '后端': 'backend',
  '接口': 'backend',
  'API': 'backend',
  '数据库': 'backend',
  '部署': 'devops',
  'Docker': 'devops',
  '容器': 'devops',
  '测试': 'test',
  'Bug': 'test',
  '文档': 'docs',
  '运营': 'ops',
  '内容': 'ops'
};

/**
 * 分析任务描述，自动选择合适的 Agent
 * 优先匹配更长的关键词（更具体）
 */
function selectAgent(taskDescription, taskTitle) {
  const text = `${taskTitle} ${taskDescription}`.toLowerCase();

  // 按关键词长度排序，优先匹配更长的关键词
  const sortedKeywords = Object.entries(TASK_AGENT_MAP)
    .sort((a, b) => b[0].length - a[0].length);

  // 1. 首先尝试关键词匹配（按长度排序）
  for (const [keyword, agentId] of sortedKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      return agentId;
    }
  }

  // 2. 尝试中文关键词匹配
  for (const [keyword, taskType] of Object.entries(KEYWORD_TASK_TYPE_MAP)) {
    if (text.includes(keyword.toLowerCase())) {
      // 根据任务类型返回对应的 Agent
      const typeAgentMap = {
        'design': 'architect',
        'frontend': 'frontend',
        'backend': 'backend',
        'devops': 'devops',
        'test': 'test',
        'docs': 'ops'
      };
      return typeAgentMap[taskType];
    }
  }

  // 3. 默认返回 backend（通用编程任务）
  return 'backend';
}

/**
 * 判断是否需要多 Agent 协作
 */
function needsMultipleAgents(taskDescription, taskTitle) {
  const text = `${taskTitle} ${taskDescription}`.toLowerCase();

  // 检查是否包含多个领域的关键词
  const domains = {
    frontend: ['前端', 'frontend', 'ui', '界面', '组件', 'react', 'vue', 'css'],
    backend: ['后端', 'backend', 'api', '数据库', 'sql', 'service', 'controller'],
    devops: ['部署', 'devops', 'docker', '容器', 'k8s', 'ci/cd'],
    test: ['测试', 'test', 'bug', '调试']
  };

  let matchedDomains = 0;
  for (const [domain, keywords] of Object.entries(domains)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        matchedDomains++;
        break;
      }
    }
  }

  // 如果涉及 2 个以上领域，需要多 Agent 协作
  return matchedDomains >= 2;
}

/**
 * 将任务分解为子任务
 */
function decomposeTask(taskTitle, taskDescription, selectedAgent) {
  const subtasks = [];

  // 简单的任务分解逻辑
  // 实际应用中可以使用 AI 来进行智能分解

  if (selectedAgent === 'backend') {
    // 后端任务分解
    subtasks.push({
      type: 'design',
      title: `设计 ${taskTitle} 的数据模型`,
      assignedTo: 'architect',
      priority: 8
    });
    subtasks.push({
      type: 'code',
      title: `实现 ${taskTitle} 的后端逻辑`,
      assignedTo: 'backend',
      priority: 7
    });
    subtasks.push({
      type: 'test',
      title: `编写 ${taskTitle} 的单元测试`,
      assignedTo: 'test',
      priority: 6
    });
  } else if (selectedAgent === 'frontend') {
    // 前端任务分解
    subtasks.push({
      type: 'design',
      title: `设计 ${taskTitle} 的 UI 组件结构`,
      assignedTo: 'architect',
      priority: 8
    });
    subtasks.push({
      type: 'code',
      title: `实现 ${taskTitle} 的前端组件`,
      assignedTo: 'frontend',
      priority: 7
    });
  } else if (selectedAgent === 'devops') {
    // DevOps 任务分解
    subtasks.push({
      type: 'code',
      title: `编写 ${taskTitle} 的配置脚本`,
      assignedTo: 'devops',
      priority: 8
    });
    subtasks.push({
      type: 'docs',
      title: `编写 ${taskTitle} 的部署文档`,
      assignedTo: 'ops',
      priority: 5
    });
  }

  // 如果没有自动分解，返回单个任务
  if (subtasks.length === 0) {
    return null;
  }

  return subtasks;
}

/**
 * POST /api/v1/openclaw/delegate
 * OpenClaw Gateway 委派任务到 API Gateway
 *
 * 请求体:
 * {
 *   "sessionId": "telegram-session-xxx",
 *   "message": "用户发送的消息",
 *   "fromAgent": "main",
 *   "userId": "telegram-user-id"
 * }
 */
router.post('/delegate', async (req, res) => {
  try {
    const { sessionId, message, fromAgent, userId, chatId } = req.body;

    if (!message) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameter: message',
          type: 'invalid_request_error'
        }
      });
    }

    // 记录收到的委派请求
    mainLogger.info(`收到任务委派请求 from ${fromAgent || 'unknown'}: ${message.substring(0, 100)}`);

    // 生成会话 ID（如果未提供）
    const targetSessionId = sessionId || generateSessionId();

    // 分析任务，选择合适的 Agent
    const selectedAgent = selectAgent(message, message);
    const needsDecomposition = needsMultipleAgents(message, message);

    mainLogger.info(`任务分析结果：选定 Agent=${selectedAgent}, 需要分解=${needsDecomposition}`);

    // 记录日志
    logAgentMessage(fromAgent || 'main', 'info', `收到 Telegram 任务委派：${message}`, {
      sessionId: targetSessionId,
      userId,
      chatId,
      selectedAgent,
      needsDecomposition
    });

    // 获取编排引擎
    const { wss } = await import('../index.js');
    // 使用 agents.js 中的 inMemoryStore 以保持一致性
    const agentsRouter = await import('../routes/agents.js');
    const inMemoryStore = agentsRouter.inMemoryStore;
    const taskStore = inMemoryStore?.tasks || new Map();
    const agentStore = inMemoryStore?.agents || new Map();
    const orchestrationEngine = new TaskOrchestrationEngine(taskStore, wss, agentStore);

    // 如果需要任务分解
    if (needsDecomposition) {
      const subtasks = decomposeTask(message, message, selectedAgent);

      if (subtasks && subtasks.length > 0) {
        // 创建子任务（先创建被依赖的任务）
        const createdSubtasks = [];
        let prevTaskId = null;

        for (const subtask of subtasks) {
          const dependencies = prevTaskId ? [prevTaskId] : [];
          const task = {
            taskId: generateWebhookTaskId(),
            sessionId: targetSessionId,
            type: subtask.type || 'code',
            title: subtask.title,
            description: message,
            status: 'pending',
            priority: subtask.priority || 5,
            assignedTo: subtask.assignedTo || selectedAgent,
            createdBy: 'telegram',
            dependencies,
            createdAt: Date.now()
          };

          orchestrationEngine.registerTask(task);
          createdSubtasks.push(task);
          prevTaskId = task.taskId;

          // WebSocket 推送任务更新
          wss.sendTaskUpdate(task);
        }

        logAgentMessage('system', 'info', `任务已分解为 ${createdSubtasks.length} 个子任务`, {
          subtasks: createdSubtasks.map(t => ({ id: t.taskId, title: t.title, agent: t.assignedTo }))
        });

        // 自动启动第一个任务（没有依赖）
        if (createdSubtasks.length > 0) {
          try {
            orchestrationEngine.startTask(createdSubtasks[0].taskId);
          } catch (err) {
            mainLogger.info(`等待执行：${err.message}`);
          }
        }

        return res.json({
          success: true,
          message: '任务已分解并分派给相关 Agent',
          subtasks: createdSubtasks,
          sessionId: targetSessionId
        });
      }
    }

    // 创建单个任务
    const task = {
      taskId: generateWebhookTaskId(),
      sessionId: targetSessionId,
      type: 'chat',
      title: `Telegram: ${message.substring(0, 50)}`,
      description: message,
      status: 'pending',
      priority: 7,
      assignedTo: selectedAgent,
      createdBy: 'telegram',
      dependencies: [],
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null
    };

    // 注册任务到编排引擎
    await orchestrationEngine.registerTask(task);

    // WebSocket 推送任务更新
    wss.sendTaskUpdate(task);

    // 自动启动任务（Telegram 任务默认自动执行）
    try {
      orchestrationEngine.startTask(task.taskId);
      mainLogger.info(`任务已自动启动：${task.taskId}`);
      // 启动后立即推送 agent 状态更新（通过 onTaskExecute 回调）
    } catch (err) {
      mainLogger.info(`任务等待执行：${err.message}`);
      // 即使等待执行，也要更新 agent 状态
      const agent = agentStore.get(selectedAgent);
      if (agent) {
        agent.status = 'busy';
        agent.currentTaskId = task.taskId;
        wss.sendAgentUpdate(agent);
      }
    }

    // 记录日志
    logAgentMessage(selectedAgent, 'info', `收到 Telegram 任务：${message}`, {
      taskId: task.taskId,
      sessionId: targetSessionId
    });

    mainLogger.info(`任务已创建并分派给 ${selectedAgent}: ${task.taskId}`);

    res.json({
      success: true,
      message: `任务已分派给 ${selectedAgent} Agent`,
      task: task,
      sessionId: targetSessionId,
      selectedAgent
    });

  } catch (error) {
    mainLogger.error('任务委派失败:', error.message);
    logAgentMessage('system', 'error', `任务委派失败：${error.message}`, req.body);

    res.status(500).json({
      error: {
        message: error.message || 'Failed to delegate task',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/openclaw/agents/status
 * 获取所有 Agent 状态（供 OpenClaw 查询）
 */
router.get('/agents/status', async (req, res) => {
  try {
    const { wss } = await import('../index.js');

    // 从内存存储获取 Agent 状态
    // 这里需要从外部获取 agent 状态
    const agents = [
      { id: 'architect', name: '架构师', status: 'idle' },
      { id: 'frontend', name: '前端开发', status: 'idle' },
      { id: 'backend', name: '后端开发', status: 'idle' },
      { id: 'devops', name: 'DevOps', status: 'idle' },
      { id: 'test', name: '测试工程师', status: 'idle' },
      { id: 'ops', name: '运营专家', status: 'idle' }
    ];

    res.json({
      success: true,
      agents
    });
  } catch (error) {
    mainLogger.error('获取 Agent 状态失败:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get agents status',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/openclaw/tasks/:id/status
 * 获取任务状态（供 OpenClaw 查询）
 */
router.get('/tasks/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    // 从全局存储获取任务状态
    // 注意：这个端点需要通过 agents.js 暴露的 store 来获取
    // 由于模块循环依赖，这里返回一个占位响应
    res.json({
      success: true,
      task: {
        taskId: id,
        status: 'unknown',
        message: 'Task status lookup not yet implemented'
      }
    });
  } catch (error) {
    mainLogger.error('获取任务状态失败:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get task status',
        type: 'server_error'
      }
    });
  }
});

export default router;
