import { Router } from 'express';
import { syncOpenClawAgents, startSyncLoop, getOpenClawSessions, sendAgentMessage, executeAgentTask } from '../controllers/openclawController.js';
import { wss } from '../index.js';
import { logAgentMessage, getAgentLogs, getAllLogs, clearAgentLogs, mainLogger } from '../utils/logger.js';
import { TaskOrchestrationEngine } from '../utils/taskOrchestrator.js';
import { SessionManager, MultiSessionScheduler } from '../utils/sessionConcurrency.js';
import * as agentMetrics from '../utils/agentMetrics.js';

export const router = Router();

// 内存存储（降级模式，不需要 Redis）
export const inMemoryStore = {
  sessions: new Map(),
  agents: new Map(),
  tasks: new Map()
};

// 任务 ID 生成器
let taskIdCounter = 0;
function generateTaskId() {
  return `task-${++taskIdCounter}`;
}

// 获取编排引擎（延迟初始化以避免循环依赖）
let orchestrationEngine = null;
const getOrchestrationEngine = async () => {
  if (!orchestrationEngine) {
    const { wss } = await import('../index.js');
    orchestrationEngine = new TaskOrchestrationEngine(inMemoryStore.tasks, wss, inMemoryStore.agents);
  }
  return orchestrationEngine;
};

// 初始化会话管理器
const sessionManager = new SessionManager();
const scheduler = new MultiSessionScheduler(sessionManager, inMemoryStore.tasks, null);

// 获取调度器（延迟初始化）
const getScheduler = async () => {
  if (!scheduler.wss) {
    const { wss } = await import('../index.js');
    scheduler.wss = wss;
  }
  return scheduler;
};

// 注册默认会话
sessionManager.registerSession({
  sessionId: 'default',
  name: '默认会话',
  maxConcurrentTasks: 3,
  priority: 5
});

// 定期保存指标快照（每 30 秒）
setInterval(() => {
  for (const agent of inMemoryStore.agents.values()) {
    agentMetrics.saveMetricsSnapshot(agent.id);
  }
}, 30000);

/**
 * 初始化默认 Agents
 */
const defaultAgents = [
  {
    id: 'architect',
    name: '架构师',
    emoji: '🏗️',
    role: 'system-design',
    model: 'qwen3.5-plus',
    status: 'offline'
  },
  {
    id: 'frontend',
    name: '前端开发',
    emoji: '🎨',
    role: 'frontend-dev',
    model: 'qwen3-coder-plus',
    status: 'offline'
  },
  {
    id: 'backend',
    name: '后端开发',
    emoji: '⚙️',
    role: 'backend-dev',
    model: 'qwen3-coder-plus',
    status: 'offline'
  },
  {
    id: 'devops',
    name: 'DevOps',
    emoji: '🚀',
    role: 'devops',
    model: 'qwen3-coder-next',
    status: 'offline'
  },
  {
    id: 'test',
    name: '测试工程师',
    emoji: '🧪',
    role: 'testing',
    model: 'qwen3.5-plus',
    status: 'offline'
  },
  {
    id: 'ops',
    name: '运营专家',
    emoji: '📝',
    role: 'operations',
    model: 'kimi-k2.5',
    status: 'offline'
  }
];

// 初始化内存存储
defaultAgents.forEach(agent => {
  inMemoryStore.agents.set(agent.id, { ...agent });
});

// 启动 OpenClaw 同步循环（每 5 秒）- 延迟初始化以避免循环依赖
const startAgentSync = async () => {
  const { wss } = await import('../index.js');
  startSyncLoop(inMemoryStore, wss, 5000);
};
startAgentSync();

/**
 * GET /api/v1/agents
 * 获取所有可用 Agent 列表（同步 OpenClaw 状态）
 */
router.get('/', async (req, res) => {
  try {
    // 尝试从 OpenClaw 同步状态
    await syncOpenClawAgents(inMemoryStore);

    const agents = Array.from(inMemoryStore.agents.values());
    res.json({ agents });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get agents',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/:id/status
 * 获取特定 Agent 的状态
 */
router.get('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const agent = inMemoryStore.agents.get(id);

    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    res.json(agent);
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get agent status',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/agents/:id/action
 * 控制 Agent（启动/停止/重启）
 */
router.post('/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, sessionId } = req.body;

    if (!action) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameter: action',
          type: 'invalid_request_error'
        }
      });
    }

    // 验证 agent 是否存在
    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    // 执行动作
    switch (action) {
      case 'start': {
        agent.status = 'idle';
        const targetSessionId = sessionId || `session-${Date.now()}`;

        // 创建或更新会话
        if (!inMemoryStore.sessions.has(targetSessionId)) {
          inMemoryStore.sessions.set(targetSessionId, {
            sessionId: targetSessionId,
            status: 'active',
            agentCount: 0,
            taskCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            agents: []
          });
        }

        // 将 Agent 加入会话
        const session = inMemoryStore.sessions.get(targetSessionId);
        if (!session.agents.includes(id)) {
          session.agents.push(id);
          session.agentCount = session.agents.length;
          session.updatedAt = Date.now();
        }

        // WebSocket 推送 Agent 状态更新
        wss.sendAgentUpdate(agent);

        res.json({
          success: true,
          message: `Agent ${id} started`,
          sessionId: targetSessionId,
          status: 'idle'
        });
        break;
      }

      case 'stop':
        agent.status = 'offline';
        // WebSocket 推送 Agent 状态更新
        wss.sendAgentUpdate(agent);
        res.json({
          success: true,
          message: `Agent ${id} stopped`,
          status: 'offline'
        });
        break;

      case 'restart':
        agent.status = 'offline';
        // WebSocket 推送 Agent 状态更新
        wss.sendAgentUpdate(agent);
        setTimeout(() => {
          agent.status = 'idle';
          wss.sendAgentUpdate(agent);
        }, 100);
        res.json({
          success: true,
          message: `Agent ${id} restarted`,
          status: 'idle'
        });
        break;

      case 'heartbeat':
        agent.lastHeartbeat = Date.now();
        res.json({
          success: true,
          message: `Heartbeat received from ${id}`
        });
        break;

      default:
        res.status(400).json({
          error: {
            message: `Invalid action: ${action}`,
            type: 'invalid_request_error'
          }
        });
    }
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to execute action',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/sessions/list
 * 获取所有活跃会话（同步 OpenClaw 会话）
 */
router.get('/sessions/list', async (req, res) => {
  try {
    // 尝试从 OpenClaw 同步会话
    const remoteSessions = await getOpenClawSessions();

    // 合并远程会话
    remoteSessions.forEach(session => {
      if (!inMemoryStore.sessions.has(session.id)) {
        inMemoryStore.sessions.set(session.id, {
          sessionId: session.id,
          status: 'active',
          agentCount: session.agentCount || 0,
          taskCount: session.taskCount || 0,
          createdAt: session.createdAt || Date.now(),
          updatedAt: Date.now(),
          agents: session.agents || [],
          remote: true
        });
      }
    });

    const sessions = Array.from(inMemoryStore.sessions.values());
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get sessions',
        type: 'server_error'
      }
    });
  }
});

/**
 * DELETE /api/v1/agents/sessions/:id
 * 删除会话
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    inMemoryStore.sessions.delete(id);
    res.json({
      success: true,
      message: `Session ${id} deleted`
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to delete session',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/tasks
 * 创建新任务（支持依赖管理）
 */
router.post('/tasks', async (req, res) => {
  try {
    const { sessionId, type, title, description, priority = 5, assignedTo, dependencies = [], autoStart = false } = req.body;

    if (!sessionId || !type || !title) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameters: sessionId, type, title',
          type: 'invalid_request_error'
        }
      });
    }

    const task = {
      taskId: generateTaskId(),
      sessionId,
      type, // chat | code | review | deploy | test | docs | design
      title,
      description: description || '',
      status: 'pending', // pending | running | completed | failed | cancelled
      priority, // 0-10
      assignedTo: assignedTo || null,
      createdBy: 'user',
      dependencies, // 依赖的任务 ID 列表
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null
    };

    // 注册任务到编排引擎
    await getOrchestrationEngine().then(engine => engine.registerTask(task));

    // 更新会话的任务数
    const session = inMemoryStore.sessions.get(sessionId);
    if (session) {
      session.taskCount = (session.taskCount || 0) + 1;
      session.updatedAt = Date.now();
    }

    // WebSocket 推送新任务
    wss.sendTaskUpdate(task);

    // 如果指定了自动开始，尝试启动任务
    if (autoStart) {
      try {
        const engine = await getOrchestrationEngine();
        engine.startTask(task.taskId);
      } catch (err) {
        // 依赖未满足，任务仍在队列中等待
        mainLogger.info(`Task ${task.taskId} waiting for dependencies: ${err.message}`);
      }
    }

    res.status(201).json({
      success: true,
      task
    });
  } catch (error) {
    mainLogger.error('Failed to create task:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create task',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/tasks
 * 获取任务列表
 */
router.get('/tasks', async (req, res) => {
  try {
    const { sessionId, status, assignedTo } = req.query;
    let tasks = Array.from(inMemoryStore.tasks.values());

    // 过滤
    if (sessionId) {
      tasks = tasks.filter(t => t.sessionId === sessionId);
    }
    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (assignedTo) {
      tasks = tasks.filter(t => t.assignedTo === assignedTo);
    }

    // 按优先级和创建时间排序
    tasks.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);

    res.json({ tasks });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get tasks',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/tasks/:id
 * 获取特定任务详情
 */
router.get('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const task = inMemoryStore.tasks.get(id);

    if (!task) {
      return res.status(404).json({
        error: {
          message: `Task not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    res.json({ task });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get task',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/tasks/:id/action
 * 执行任务操作（开始/完成/失败/取消）
 */
router.post('/tasks/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, result } = req.body;

    const task = inMemoryStore.tasks.get(id);
    if (!task) {
      return res.status(404).json({
        error: {
          message: `Task not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    switch (action) {
      case 'start':
        task.status = 'running';
        task.startedAt = Date.now();
        if (task.assignedTo) {
          const agent = inMemoryStore.agents.get(task.assignedTo);
          if (agent) {
            agent.status = 'busy';
            agent.currentTaskId = id;
          }
        }
        break;

      case 'execute':
        // 执行实际的任务到 OpenClaw Agent
        if (!task.assignedTo) {
          return res.status(400).json({
            error: {
              message: 'Task not assigned to any agent',
              type: 'invalid_request_error'
            }
          });
        }

        task.status = 'running';
        task.startedAt = Date.now();

        const agent = inMemoryStore.agents.get(task.assignedTo);
        if (agent) {
          agent.status = 'busy';
          agent.currentTaskId = id;

          // 记录任务开始
          agentMetrics.recordTaskStart(task.assignedTo, task.taskId);
        }

        // WebSocket 推送任务状态更新
        wss.sendTaskUpdate(task);

        // 异步执行任务，不阻塞响应
        (async () => {
          try {
            const taskResult = await executeAgentTask(task.assignedTo, task);

            if (taskResult.success) {
              task.status = 'completed';
              task.result = taskResult.response;

              // 记录任务完成
              const tokensUsed = taskResult.response?.usage?.totalTokens || 0;
              agentMetrics.recordTaskComplete(task.assignedTo, task.taskId, tokensUsed);
            } else {
              task.status = 'failed';
              task.error = taskResult.error;

              // 记录任务失败
              agentMetrics.recordTaskFailed(task.assignedTo, task.taskId);
            }

            task.completedAt = Date.now();

            if (agent) {
              agent.status = taskResult.success ? 'idle' : 'error';
              agent.currentTaskId = null;
              if (taskResult.success) {
                agent.stats = agent.stats || {};
                agent.stats.tasksCompleted = (agent.stats.tasksCompleted || 0) + 1;
              } else {
                agent.stats = agent.stats || {};
                agent.stats.tasksFailed = (agent.stats.tasksFailed || 0) + 1;
              }
            }

            // WebSocket 推送最终状态
            wss.sendTaskUpdate(task);
            if (agent) wss.sendAgentUpdate(agent);

          } catch (error) {
            task.status = 'failed';
            task.error = error.message;
            task.completedAt = Date.now();
            if (agent) {
              agent.status = 'error';
              agent.currentTaskId = null;
            }

            // 记录任务失败
            agentMetrics.recordTaskFailed(task.assignedTo, task.taskId);

            wss.sendTaskUpdate(task);
            if (agent) wss.sendAgentUpdate(agent);
          }
        })();

        break;

      case 'complete':
        task.status = 'completed';
        task.result = result || null;
        task.completedAt = Date.now();
        if (task.assignedTo) {
          const agent = inMemoryStore.agents.get(task.assignedTo);
          if (agent) {
            agent.status = 'idle';
            agent.currentTaskId = null;
            agent.stats = agent.stats || {};
            agent.stats.tasksCompleted = (agent.stats.tasksCompleted || 0) + 1;
            wss.sendAgentUpdate(agent);
          }
        }
        wss.sendTaskUpdate(task);
        break;

      case 'fail':
        task.status = 'failed';
        task.error = result?.error || 'Unknown error';
        task.completedAt = Date.now();
        if (task.assignedTo) {
          const agent = inMemoryStore.agents.get(task.assignedTo);
          if (agent) {
            agent.status = 'error';
            agent.currentTaskId = null;
            agent.stats = agent.stats || {};
            agent.stats.tasksFailed = (agent.stats.tasksFailed || 0) + 1;
            wss.sendAgentUpdate(agent);
          }
        }
        wss.sendTaskUpdate(task);
        break;

      case 'cancel':
        task.status = 'cancelled';
        task.completedAt = Date.now();
        if (task.assignedTo) {
          const agent = inMemoryStore.agents.get(task.assignedTo);
          if (agent) {
            agent.status = 'idle';
            agent.currentTaskId = null;
          }
        }
        break;

      default:
        return res.status(400).json({
          error: {
            message: `Invalid action: ${action}`,
            type: 'invalid_request_error'
          }
        });
    }

    res.json({
      success: true,
      task
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to execute task action',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/tasks/:id/assign
 * 分配任务给 Agent
 */
router.post('/tasks/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;

    const task = inMemoryStore.tasks.get(id);
    if (!task) {
      return res.status(404).json({
        error: {
          message: `Task not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const agent = inMemoryStore.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${agentId}`,
          type: 'not_found'
        }
      });
    }

    task.assignedTo = agentId;

    // 如果任务是 pending 状态且 Agent 空闲，自动开始
    if (task.status === 'pending' && agent.status === 'idle') {
      task.status = 'running';
      task.startedAt = Date.now();
      agent.status = 'busy';
      agent.currentTaskId = id;
    }

    res.json({
      success: true,
      task
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message || 'Failed to assign task',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/agents/:id/message
 * 向 Agent 发送消息
 */
router.post('/:id/message', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameter: message',
          type: 'invalid_request_error'
        }
      });
    }

    // 验证 agent 是否存在
    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    // 记录日志
    logAgentMessage(id, 'info', `收到消息：${message}`, { sessionId, messageType: 'user_message' });

    // 发送消息到 OpenClaw Agent
    const result = await sendAgentMessage(id, message, sessionId);

    if (!result.success) {
      logAgentMessage(id, 'error', `消息发送失败：${result.error}`, { messageType: 'response_error' });
      return res.status(500).json({
        error: {
          message: result.error || 'Failed to send message',
          type: 'server_error'
        }
      });
    }

    // 记录响应日志
    logAgentMessage(id, 'info', `回复：${result.response?.substring(0, 100)}...`, {
      messageType: 'agent_response',
      usage: result.usage
    });

    res.json({
      success: true,
      message: result.response,
      usage: result.usage
    });
  } catch (error) {
    logAgentMessage('system', 'error', `发送消息失败：${error.message}`, { agentId: req.params.id });
    res.status(500).json({
      error: {
        message: error.message || 'Failed to send message',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/:id/logs
 * 获取 Agent 日志列表
 */
router.get('/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const { level, startTime, endTime, search, limit = 100, offset = 0 } = req.query;

    // 验证 agent 是否存在
    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const options = {
      level,
      startTime: startTime ? parseInt(startTime) : undefined,
      endTime: endTime ? parseInt(endTime) : undefined,
      search,
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    const result = getAgentLogs(id, options);
    res.json(result);
  } catch (error) {
    mainLogger.error('Failed to get agent logs:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get logs',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/logs
 * 获取所有 Agent 的日志
 */
router.get('/logs', async (req, res) => {
  try {
    const { level, agentId, search, limit = 100, offset = 0 } = req.query;

    const options = {
      level,
      agentId,
      search,
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    // 获取所有日志
    let allLogs = getAllLogs(options);

    // 如果指定了 agentId，过滤该 Agent 的日志
    if (agentId) {
      allLogs.logs = allLogs.logs.filter(log => log.agentId === agentId);
      allLogs.total = allLogs.logs.length;
    }

    res.json(allLogs);
  } catch (error) {
    mainLogger.error('Failed to get all logs:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get logs',
        type: 'server_error'
      }
    });
  }
});

/**
 * DELETE /api/v1/agents/:id/logs
 * 清除 Agent 日志
 */
router.delete('/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;

    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    clearAgentLogs(id);
    res.json({
      success: true,
      message: `Logs cleared for agent ${id}`
    });
  } catch (error) {
    mainLogger.error('Failed to clear agent logs:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to clear logs',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/:id/logs/stream
 * WebSocket 日志流式推送（连接到 Agent 日志）
 */
router.get('/:id/logs/stream', async (req, res) => {
  // 这个端点用于初始化 WebSocket 日志订阅
  // 实际的日志推送通过 WebSocket 进行
  const { id } = req.params;

  const agent = inMemoryStore.agents.get(id);
  if (!agent) {
    return res.status(404).json({
      error: {
        message: `Agent not found: ${id}`,
        type: 'not_found'
      }
    });
  }

  res.json({
    success: true,
    message: `Log stream initialized for agent ${id}`,
    wsEndpoint: `/ws`
  });
});

/**
 * GET /api/v1/tasks/orchestration/plan/:sessionId
 * 获取任务执行计划（拓扑排序）
 */
router.get('/orchestration/plan/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const engine = await getOrchestrationEngine();
    const plan = engine.getExecutionPlan(sessionId);

    res.json({
      success: true,
      ...plan
    });
  } catch (error) {
    mainLogger.error('Failed to get execution plan:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get execution plan',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/tasks/queue/status
 * 获取任务队列状态
 */
router.get('/tasks/queue/status', async (req, res) => {
  try {
    const engine = await getOrchestrationEngine();
    const status = engine.getQueueStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    mainLogger.error('Failed to get queue status:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get queue status',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/tasks/:id/start
 * 手动启动任务
 */
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;

    const task = inMemoryStore.tasks.get(id);
    if (!task) {
      return res.status(404).json({
        error: {
          message: `Task not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const engine = await getOrchestrationEngine();
    engine.startTask(id);

    res.json({
      success: true,
      message: `Task ${id} started`
    });
  } catch (error) {
    mainLogger.error('Failed to start task:', error.message);
    res.status(400).json({
      error: {
        message: error.message || 'Failed to start task',
        type: 'invalid_request_error'
      }
    });
  }
});

/**
 * POST /api/v1/tasks/batch
 * 批量创建任务（支持依赖关系）
 */
router.post('/batch', async (req, res) => {
  try {
    const { sessionId, tasks } = req.body;

    if (!sessionId || !Array.isArray(tasks)) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameters: sessionId, tasks',
          type: 'invalid_request_error'
        }
      });
    }

    const engine = await getOrchestrationEngine();
    const createdTasks = [];

    for (const taskData of tasks) {
      const task = {
        taskId: generateTaskId(),
        sessionId,
        ...taskData,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null
      };

      engine.registerTask(task);
      createdTasks.push(task);
    }

    // WebSocket 推送新任务
    const { wss } = await import('../index.js');
    createdTasks.forEach(task => wss.sendTaskUpdate(task));

    res.json({
      success: true,
      tasks: createdTasks
    });
  } catch (error) {
    mainLogger.error('Failed to create batch tasks:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create batch tasks',
        type: 'server_error'
      }
    });
  }
});

/**
 * =====================
 *  多会话并发控制 API
 * =====================
 */

/**
 * POST /api/v1/sessions
 * 创建新会话
 */
router.post('/sessions', async (req, res) => {
  try {
    const { sessionId, name, maxConcurrentTasks = 3, priority = 5, agentPool = [] } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameter: sessionId',
          type: 'invalid_request_error'
        }
      });
    }

    const session = sessionManager.registerSession({
      sessionId,
      name,
      maxConcurrentTasks,
      priority,
      agentPool
    });

    res.json({
      success: true,
      session
    });
  } catch (error) {
    mainLogger.error('Failed to create session:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to create session',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/sessions
 * 获取所有会话状态
 */
router.get('/sessions', async (req, res) => {
  try {
    const sessions = sessionManager.getAllSessionsStatus();
    const globalStatus = sessionManager.getGlobalStatus();

    res.json({
      success: true,
      sessions,
      global: globalStatus
    });
  } catch (error) {
    mainLogger.error('Failed to get sessions:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get sessions',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/sessions/concurrency/status
 * 获取并发状态详情（必须在 /sessions/:id 之前定义）
 */
router.get('/sessions/concurrency/status', async (req, res) => {
  try {
    const sessions = sessionManager.getAllSessionsStatus();
    const global = sessionManager.getGlobalStatus();

    res.json({
      success: true,
      global,
      sessions
    });
  } catch (error) {
    mainLogger.error('Failed to get concurrency status:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get concurrency status',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/sessions/:id
 * 获取特定会话状态
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const session = sessionManager.getSession(id);
    if (!session) {
      return res.status(404).json({
        error: {
          message: `Session not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const resource = sessionManager.getResourceTracker(id);
    const status = resource ? resource.getStatus() : null;

    res.json({
      success: true,
      session: {
        config: session,
        status
      }
    });
  } catch (error) {
    mainLogger.error('Failed to get session:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get session',
        type: 'server_error'
      }
    });
  }
});

/**
 * PUT /api/v1/sessions/:id
 * 更新会话配置
 */
router.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const session = sessionManager.getSession(id);
    if (!session) {
      return res.status(404).json({
        error: {
          message: `Session not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    sessionManager.updateSessionConfig(id, updates);

    res.json({
      success: true,
      session: sessionManager.getSession(id)
    });
  } catch (error) {
    mainLogger.error('Failed to update session:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to update session',
        type: 'server_error'
      }
    });
  }
});

/**
 * DELETE /api/v1/sessions/:id
 * 删除会话
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const session = sessionManager.getSession(id);
    if (!session) {
      return res.status(404).json({
        error: {
          message: `Session not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    // 检查是否有运行中的任务
    const resource = sessionManager.getResourceTracker(id);
    if (resource && resource.currentUsage.runningTasks > 0) {
      return res.status(400).json({
        error: {
          message: `Cannot delete session with ${resource.currentUsage.runningTasks} running tasks`,
          type: 'invalid_request_error'
        }
      });
    }

    sessionManager.removeSession(id);

    res.json({
      success: true,
      message: `Session ${id} deleted`
    });
  } catch (error) {
    mainLogger.error('Failed to delete session:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to delete session',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/sessions/:id/reset
 * 重置会话资源
 */
router.post('/sessions/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;

    const resource = sessionManager.getResourceTracker(id);
    if (!resource) {
      return res.status(404).json({
        error: {
          message: `Session not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    resource.reset();

    res.json({
      success: true,
      message: `Session ${id} resources reset`
    });
  } catch (error) {
    mainLogger.error('Failed to reset session:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to reset session',
        type: 'server_error'
      }
    });
  }
});

export default router;

/**
 * =====================
 *  Agent 指标监控 API
 * =====================
 */

/**
 * GET /api/v1/agents/metrics/system
 * 获取系统整体指标
 */
router.get('/metrics/system', async (req, res) => {
  try {
    const systemMetrics = agentMetrics.getSystemMetrics();
    res.json({
      success: true,
      ...systemMetrics
    });
  } catch (error) {
    mainLogger.error('Failed to get system metrics:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get system metrics',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/metrics
 * 获取所有 Agent 指标
 */
router.get('/metrics', async (req, res) => {
  try {
    const metrics = agentMetrics.getAllAgentsMetrics();
    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    mainLogger.error('Failed to get all metrics:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get all metrics',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/:id/metrics
 * 获取特定 Agent 指标
 */
router.get('/:id/metrics', async (req, res) => {
  try {
    const { id } = req.params;

    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const metrics = agentMetrics.getAgentMetrics(id);
    const trend = agentMetrics.getMetricsTrend(id);

    res.json({
      success: true,
      metrics: metrics || { agentId: id, timestamp: Date.now() },
      trend
    });
  } catch (error) {
    mainLogger.error('Failed to get agent metrics:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get agent metrics',
        type: 'server_error'
      }
    });
  }
});

/**
 * GET /api/v1/agents/:id/metrics/history
 * 获取 Agent 指标历史
 */
router.get('/:id/metrics/history', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;

    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    const history = agentMetrics.getAgentMetricsHistory(id, parseInt(limit));
    res.json({
      success: true,
      history
    });
  } catch (error) {
    mainLogger.error('Failed to get agent metrics history:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get agent metrics history',
        type: 'server_error'
      }
    });
  }
});

/**
 * POST /api/v1/agents/:id/metrics/reset
 * 重置 Agent 指标
 */
router.post('/:id/metrics/reset', async (req, res) => {
  try {
    const { id } = req.params;

    const agent = inMemoryStore.agents.get(id);
    if (!agent) {
      return res.status(404).json({
        error: {
          message: `Agent not found: ${id}`,
          type: 'not_found'
        }
      });
    }

    agentMetrics.resetAgentMetrics(id);

    res.json({
      success: true,
      message: `Metrics reset for agent ${id}`
    });
  } catch (error) {
    mainLogger.error('Failed to reset agent metrics:', error.message);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to reset agent metrics',
        type: 'server_error'
      }
    });
  }
});
