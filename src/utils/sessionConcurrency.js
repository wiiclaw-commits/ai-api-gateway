/**
 * 多会话并发控制系统
 * 支持会话隔离、优先级管理、资源分配
 */

/**
 * 会话配置
 */
class SessionConfig {
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    this.name = options.name || 'Default Session';
    this.maxConcurrentTasks = options.maxConcurrentTasks || 3; // 会话最大并发任务数
    this.priority = options.priority || 5; // 会话优先级 0-10
    this.agentPool = options.agentPool || []; // 专属 Agent 池
    this.resourceLimit = options.resourceLimit || {
      maxTokens: 100000,
      maxRequests: 100,
      timeLimit: 3600000 // 1 小时
    };
  }
}

/**
 * 会话资源跟踪器
 */
class SessionResourceTracker {
  constructor(config) {
    this.config = config;
    this.currentUsage = {
      tokens: 0,
      requests: 0,
      runningTasks: 0
    };
    this.startTime = Date.now();
    this.taskHistory = [];
  }

  /**
   * 开始任务
   */
  startTask(task) {
    this.currentUsage.runningTasks++;
    this.currentUsage.requests++;
    this.taskHistory.push({
      taskId: task.taskId,
      startedAt: Date.now(),
      status: 'running'
    });
  }

  /**
   * 完成任务
   */
  completeTask(taskId, tokensUsed = 0) {
    this.currentUsage.runningTasks--;
    this.currentUsage.tokens += tokensUsed;

    const history = this.taskHistory.find(h => h.taskId === taskId);
    if (history) {
      history.completedAt = Date.now();
      history.status = 'completed';
      history.tokensUsed = tokensUsed;
    }
  }

  /**
   * 检查资源是否充足
   */
  canAllocate() {
    if (this.currentUsage.runningTasks >= this.config.maxConcurrentTasks) {
      return { allowed: false, reason: '达到最大并发任务数' };
    }
    if (this.currentUsage.requests >= this.config.resourceLimit.maxRequests) {
      return { allowed: false, reason: '达到最大请求数限制' };
    }
    if (this.currentUsage.tokens >= this.config.resourceLimit.maxTokens) {
      return { allowed: false, reason: '达到 Token 限制' };
    }
    const elapsed = Date.now() - this.startTime;
    if (elapsed >= this.config.resourceLimit.timeLimit) {
      return { allowed: false, reason: '会话时间超限' };
    }
    return { allowed: true };
  }

  /**
   * 获取资源使用状态
   */
  getStatus() {
    return {
      sessionId: this.config.sessionId,
      name: this.config.name,
      priority: this.config.priority,
      usage: {
        runningTasks: this.currentUsage.runningTasks,
        maxConcurrent: this.config.maxConcurrentTasks,
        tokensUsed: this.currentUsage.tokens,
        maxTokens: this.config.resourceLimit.maxTokens,
        requestsMade: this.currentUsage.requests,
        maxRequests: this.config.resourceLimit.maxRequests,
        elapsedMs: Date.now() - this.startTime,
        timeLimitMs: this.config.resourceLimit.timeLimit
      },
      availableAgents: this.config.agentPool.length,
      taskHistory: this.taskHistory.length
    };
  }

  /**
   * 重置资源
   */
  reset() {
    this.currentUsage = {
      tokens: 0,
      requests: 0,
      runningTasks: 0
    };
    this.startTime = Date.now();
    this.taskHistory = [];
  }
}

/**
 * 会话管理器
 */
class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionConfig
    this.resources = new Map(); // sessionId -> SessionResourceTracker
    this.globalMaxConcurrent = 10; // 全局最大并发任务数
    this.globalRunningTasks = 0;
  }

  /**
   * 注册会话
   */
  registerSession(config) {
    const session = new SessionConfig(config);
    this.sessions.set(session.sessionId, session);
    this.resources.set(session.sessionId, new SessionResourceTracker(session));
    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取会话资源跟踪器
   */
  getResourceTracker(sessionId) {
    return this.resources.get(sessionId);
  }

  /**
   * 检查会话是否可以启动新任务
   */
  canStartTask(sessionId) {
    const tracker = this.resources.get(sessionId);
    if (!tracker) {
      return { allowed: false, reason: '会话不存在' };
    }

    // 检查会话资源
    const sessionCheck = tracker.canAllocate();
    if (!sessionCheck.allowed) {
      return sessionCheck;
    }

    // 检查全局并发限制
    if (this.globalRunningTasks >= this.globalMaxConcurrent) {
      return { allowed: false, reason: '全局并发任务数已达上限' };
    }

    return { allowed: true };
  }

  /**
   * 开始任务
   */
  startTask(sessionId, task) {
    const check = this.canStartTask(sessionId);
    if (!check.allowed) {
      return check;
    }

    const tracker = this.resources.get(sessionId);
    tracker.startTask(task);
    this.globalRunningTasks++;

    return { allowed: true };
  }

  /**
   * 完成任务
   */
  completeTask(sessionId, taskId, tokensUsed = 0) {
    const tracker = this.resources.get(sessionId);
    if (tracker) {
      tracker.completeTask(taskId, tokensUsed);
    }
    this.globalRunningTasks--;
    if (this.globalRunningTasks < 0) {
      this.globalRunningTasks = 0;
    }
  }

  /**
   * 获取所有会话状态
   */
  getAllSessionsStatus() {
    const statuses = [];
    for (const [sessionId, tracker] of this.resources.entries()) {
      statuses.push(tracker.getStatus());
    }
    // 按优先级排序
    return statuses.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取全局状态
   */
  getGlobalStatus() {
    return {
      totalSessions: this.sessions.size,
      globalRunningTasks: this.globalRunningTasks,
      globalMaxConcurrent: this.globalMaxConcurrent,
      availableSlots: this.globalMaxConcurrent - this.globalRunningTasks
    };
  }

  /**
   * 删除会话
   */
  removeSession(sessionId) {
    this.sessions.delete(sessionId);
    this.resources.delete(sessionId);
  }

  /**
   * 更新会话配置
   */
  updateSessionConfig(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
      const tracker = this.resources.get(sessionId);
      if (tracker) {
        tracker.config = session;
      }
    }
  }
}

/**
 * 多会话任务调度器
 */
class MultiSessionScheduler {
  constructor(sessionManager, taskStore, wss) {
    this.sessionManager = sessionManager;
    this.taskStore = taskStore;
    this.wss = wss;
    this.sessionQueues = new Map(); // sessionId -> task queue
    this.schedulerInterval = null;
  }

  /**
   * 启动调度器
   */
  start(intervalMs = 1000) {
    this.schedulerInterval = setInterval(() => {
      this.schedule();
    }, intervalMs);
  }

  /**
   * 停止调度器
   */
  stop() {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }

  /**
   * 调度任务
   */
  schedule() {
    // 获取所有会话
    const sessionStatuses = this.sessionManager.getAllSessionsStatus();

    for (const session of sessionStatuses) {
      const sessionId = session.sessionId;

      // 获取该会话的待执行任务
      const pendingTasks = this.getPendingTasksForSession(sessionId);

      // 按优先级排序
      pendingTasks.sort((a, b) => b.priority - a.priority);

      // 尝试启动任务
      for (const task of pendingTasks) {
        const result = this.sessionManager.startTask(sessionId, task);
        if (result.allowed) {
          // 更新任务状态
          task.status = 'running';
          task.startedAt = Date.now();

          // 更新 Agent 状态
          if (task.assignedTo) {
            const agent = this.taskStore.get(`agent:${task.assignedTo}`);
            if (agent) {
              agent.status = 'busy';
              agent.currentTaskId = task.taskId;
            }
          }

          // WebSocket 推送
          if (this.wss) {
            this.wss.sendTaskUpdate(task);
          }
        } else {
          // 无法启动，跳过
          break;
        }
      }
    }
  }

  /**
   * 获取会话的待执行任务
   */
  getPendingTasksForSession(sessionId) {
    const tasks = [];
    for (const task of this.taskStore.values()) {
      if (task.sessionId === sessionId && task.status === 'pending') {
        // 检查依赖
        const dependencies = task.dependencies || [];
        const depsSatisfied = dependencies.every(depId => {
          const depTask = this.taskStore.get(depId);
          return depTask && depTask.status === 'completed';
        });

        if (depsSatisfied) {
          tasks.push(task);
        }
      }
    }
    return tasks;
  }

  /**
   * 任务完成回调
   */
  onTaskComplete(sessionId, taskId, tokensUsed = 0) {
    this.sessionManager.completeTask(sessionId, taskId, tokensUsed);

    // 更新 Agent 状态
    const task = this.taskStore.get(taskId);
    if (task && task.assignedTo) {
      const agent = this.taskStore.get(`agent:${task.assignedTo}`);
      if (agent) {
        agent.status = 'idle';
        agent.currentTaskId = null;
      }
    }

    // WebSocket 推送
    if (this.wss) {
      if (task) this.wss.sendTaskUpdate(task);
    }
  }
}

export {
  SessionConfig,
  SessionResourceTracker,
  SessionManager,
  MultiSessionScheduler
};
