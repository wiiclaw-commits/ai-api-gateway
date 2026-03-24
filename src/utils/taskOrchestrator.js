/**
 * 任务编排引擎 - 处理任务依赖和执行调度
 */

/**
 * 任务依赖图
 * 使用拓扑排序解决定任务执行顺序
 */
class TaskDependencyGraph {
  constructor() {
    this.graph = new Map(); // taskId -> Set<dependentTaskIds>
    this.reverseGraph = new Map(); // taskId -> Set<dependencyTaskIds>
  }

  /**
   * 添加任务节点
   */
  addNode(taskId) {
    if (!this.graph.has(taskId)) {
      this.graph.set(taskId, new Set());
    }
    if (!this.reverseGraph.has(taskId)) {
      this.reverseGraph.set(taskId, new Set());
    }
  }

  /**
   * 添加依赖关系：taskA 依赖于 taskB（taskB 必须先完成）
   */
  addEdge(taskA, taskB) {
    this.addNode(taskA);
    this.addNode(taskB);
    this.graph.get(taskB).add(taskA); // taskB -> taskA
    this.reverseGraph.get(taskA).add(taskB); // taskA 依赖 taskB
  }

  /**
   * 移除任务节点
   */
  removeNode(taskId) {
    // 移除该任务的所有依赖关系
    const dependencies = this.reverseGraph.get(taskId) || new Set();
    for (const depId of dependencies) {
      this.graph.get(depId)?.delete(taskId);
    }

    // 移除依赖于该任务的其他任务
    const dependents = this.graph.get(taskId) || new Set();
    for (const depId of dependents) {
      this.reverseGraph.get(depId)?.delete(taskId);
    }

    this.graph.delete(taskId);
    this.reverseGraph.delete(taskId);
  }

  /**
   * 获取任务的所有依赖
   */
  getDependencies(taskId) {
    return Array.from(this.reverseGraph.get(taskId) || []);
  }

  /**
   * 获取依赖该任务的所有任务
   */
  getDependents(taskId) {
    return Array.from(this.graph.get(taskId) || []);
  }

  /**
   * 检查任务是否可以执行（所有依赖已完成）
   */
  canExecute(taskId, taskStore) {
    const dependencies = this.getDependencies(taskId);
    if (dependencies.length === 0) return true;

    for (const depId of dependencies) {
      const depTask = taskStore.get(depId);
      if (!depTask || depTask.status !== 'completed') {
        return false;
      }
    }
    return true;
  }

  /**
   * 获取可执行的任务列表
   */
  getExecutableTasks(taskStore) {
    const executable = [];
    for (const [taskId, task] of taskStore.entries()) {
      if (task.status === 'pending' && this.canExecute(taskId, taskStore)) {
        executable.push(task);
      }
    }
    return executable.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 拓扑排序 - 获取任务执行顺序
   */
  topologicalSort(taskStore) {
    const inDegree = new Map();
    const result = [];
    const queue = [];

    // 初始化入度
    for (const [taskId, task] of taskStore.entries()) {
      if (task.status === 'pending') {
        inDegree.set(taskId, this.reverseGraph.get(taskId)?.size || 0);
        if (inDegree.get(taskId) === 0) {
          queue.push(taskId);
        }
      }
    }

    // 处理队列
    while (queue.length > 0) {
      const taskId = queue.shift();
      result.push(taskId);

      const dependents = this.graph.get(taskId) || [];
      for (const dependentId of dependents) {
        if (inDegree.has(dependentId)) {
          inDegree.set(dependentId, inDegree.get(dependentId) - 1);
          if (inDegree.get(dependentId) === 0) {
            queue.push(dependentId);
          }
        }
      }
    }

    // 检查是否有环
    const pendingCount = Array.from(taskStore.values()).filter(t => t.status === 'pending').length;
    if (result.length < pendingCount) {
      throw new Error('检测到循环依赖');
    }

    return result;
  }
}

/**
 * 任务队列管理器
 */
class TaskQueueManager {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.queue = [];
    this.running = new Map(); // taskId -> task
    this.processing = false;
  }

  /**
   * 添加任务到队列
   */
  enqueue(task) {
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.processQueue();
  }

  /**
   * 从队列移除任务
   */
  dequeue(taskId) {
    const index = this.queue.findIndex(t => t.taskId === taskId);
    if (index !== -1) {
      return this.queue.splice(index, 1)[0];
    }
    return null;
  }

  /**
   * 处理队列
   */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      const task = this.queue.shift();
      this.running.set(task.taskId, task);

      // 触发任务执行回调
      if (this.onTaskExecute) {
        try {
          await this.onTaskExecute(task);
        } catch (error) {
          console.error(`Task ${task.taskId} execution error:`, error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * 任务完成
   */
  complete(taskId, result) {
    const task = this.running.get(taskId);
    if (task) {
      task.result = result;
      task.status = 'completed';
      task.completedAt = Date.now();
      this.running.delete(taskId);

      if (this.onTaskComplete) {
        this.onTaskComplete(task);
      }

      this.processQueue();
    }
  }

  /**
   * 任务失败
   */
  fail(taskId, error) {
    const task = this.running.get(taskId);
    if (task) {
      task.error = error;
      task.status = 'failed';
      task.completedAt = Date.now();
      this.running.delete(taskId);

      if (this.onTaskFail) {
        this.onTaskFail(task);
      }

      this.processQueue();
    }
  }

  /**
   * 设置回调
   */
  setOnTaskExecute(callback) {
    this.onTaskExecute = callback;
  }

  setOnTaskComplete(callback) {
    this.onTaskComplete = callback;
  }

  setOnTaskFail(callback) {
    this.onTaskFail = callback;
  }

  /**
   * 获取队列状态
   */
  getStatus() {
    return {
      queued: this.queue.map(t => t.taskId),
      running: Array.from(this.running.keys()),
      queuedCount: this.queue.length,
      runningCount: this.running.size,
      availableSlots: this.maxConcurrent - this.running.size
    };
  }
}

/**
 * 任务编排引擎
 */
class TaskOrchestrationEngine {
  constructor(taskStore, wss, agentStore) {
    this.taskStore = taskStore; // 任务存储
    this.wss = wss; // WebSocket 服务器
    this.agentStore = agentStore || null; // Agent 存储
    this.dependencyGraph = new TaskDependencyGraph();
    this.queueManager = new TaskQueueManager({ maxConcurrent: 3 });
    this.setupQueueHandlers();
  }

  /**
   * 设置队列处理器
   */
  setupQueueHandlers() {
    this.queueManager.setOnTaskExecute(async (task) => {
      // 开始执行任务
      task.status = 'running';
      task.startedAt = Date.now();

      // 更新 Agent 状态
      if (task.assignedTo && this.agentStore) {
        const agent = this.agentStore.get(task.assignedTo);
        if (agent) {
          agent.status = 'busy';
          agent.currentTaskId = task.taskId;
          // WebSocket 推送 Agent 状态更新
          if (this.wss) {
            this.wss.sendAgentUpdate(agent);
          }
        }
      }

      // WebSocket 推送
      if (this.wss) {
        this.wss.sendTaskUpdate(task);
      }
    });

    this.queueManager.setOnTaskComplete(async (task) => {
      // 更新 Agent 状态
      if (task.assignedTo && this.agentStore) {
        const agent = this.agentStore.get(task.assignedTo);
        if (agent) {
          agent.status = 'idle';
          agent.currentTaskId = null;
          agent.stats = agent.stats || {};
          agent.stats.tasksCompleted = (agent.stats.tasksCompleted || 0) + 1;
          // WebSocket 推送 Agent 状态更新
          if (this.wss) {
            this.wss.sendAgentUpdate(agent);
          }
        }
      }

      // 检查并触发依赖任务
      this.triggerDependentTasks(task.taskId);

      // WebSocket 推送
      if (this.wss) {
        this.wss.sendTaskUpdate(task);
      }
    });

    this.queueManager.setOnTaskFail(async (task) => {
      // 更新 Agent 状态
      if (task.assignedTo && this.agentStore) {
        const agent = this.agentStore.get(task.assignedTo);
        if (agent) {
          agent.status = 'error';
          agent.currentTaskId = null;
          agent.stats = agent.stats || {};
          agent.stats.tasksFailed = (agent.stats.tasksFailed || 0) + 1;
          // WebSocket 推送 Agent 状态更新
          if (this.wss) {
            this.wss.sendAgentUpdate(agent);
          }
        }
      }

      // 取消依赖该任务的所有任务
      this.cancelDependentTasks(task.taskId, `依赖任务失败：${task.error}`);

      // WebSocket 推送
      if (this.wss) {
        this.wss.sendTaskUpdate(task);
      }
    });
  }

  /**
   * 注册任务
   */
  registerTask(task) {
    this.taskStore.set(task.taskId, task);
    this.dependencyGraph.addNode(task.taskId);

    // 添加依赖关系
    for (const depId of (task.dependencies || [])) {
      this.dependencyGraph.addEdge(task.taskId, depId);
    }

    return task;
  }

  /**
   * 开始执行任务
   */
  startTask(taskId) {
    const task = this.taskStore.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // 检查依赖
    if (!this.dependencyGraph.canExecute(taskId, this.taskStore)) {
      throw new Error('Task dependencies not satisfied');
    }

    // 加入队列
    this.queueManager.enqueue(task);
  }

  /**
   * 触发依赖任务
   */
  triggerDependentTasks(completedTaskId) {
    const dependents = this.dependencyGraph.getDependents(completedTaskId);

    for (const dependentId of dependents) {
      const task = this.taskStore.get(dependentId);
      if (task && task.status === 'pending') {
        // 检查所有依赖是否都已完成
        if (this.dependencyGraph.canExecute(dependentId, this.taskStore)) {
          this.startTask(dependentId);
        }
      }
    }
  }

  /**
   * 取消依赖任务
   */
  cancelDependentTasks(failedTaskId, reason) {
    const dependents = this.dependencyGraph.getDependents(failedTaskId);

    for (const dependentId of dependents) {
      const task = this.taskStore.get(dependentId);
      if (task && task.status === 'pending') {
        task.status = 'cancelled';
        task.error = reason;
        task.completedAt = Date.now();

        // 递归取消
        this.cancelDependentTasks(dependentId, reason);

        // WebSocket 推送
        if (this.wss) {
          this.wss.sendTaskUpdate(task);
        }
      }
    }
  }

  /**
   * 获取任务执行计划
   */
  getExecutionPlan(sessionId) {
    const sessionTasks = Array.from(this.taskStore.values())
      .filter(t => t.sessionId === sessionId && t.status === 'pending');

    try {
      const order = this.dependencyGraph.topologicalSort(
        new Map(sessionTasks.map(t => [t.taskId, t]))
      );

      return {
        tasks: order.map((taskId, index) => {
          const task = sessionTasks.find(t => t.taskId === taskId);
          return {
            ...task,
            executionOrder: index + 1,
            dependencies: this.dependencyGraph.getDependencies(taskId)
          };
        }),
        hasCycle: false
      };
    } catch (error) {
      return {
        tasks: [],
        hasCycle: true,
        error: error.message
      };
    }
  }

  /**
   * 获取队列状态
   */
  getQueueStatus() {
    return this.queueManager.getStatus();
  }

  /**
   * 移除任务
   */
  removeTask(taskId) {
    this.dependencyGraph.removeNode(taskId);
    this.queueManager.dequeue(taskId);
    this.queueManager.running.delete(taskId);
  }
}

export {
  TaskDependencyGraph,
  TaskQueueManager,
  TaskOrchestrationEngine
};
