/**
 * Agent 指标收集器
 * 收集和统计 Agent 性能指标
 */

// 内存存储
const metricsStore = new Map(); // agentId -> AgentMetrics
const historyStore = new Map(); // agentId -> [MetricSnapshot]

/**
 * Agent 指标快照
 */
class MetricSnapshot {
  constructor(agentId) {
    this.agentId = agentId;
    this.timestamp = Date.now();

    // 任务指标
    this.tasksTotal = 0;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.tasksCancelled = 0;

    // 时间指标 (毫秒)
    this.totalTaskTime = 0;
    this.avgTaskTime = 0;
    this.minTaskTime = Infinity;
    this.maxTaskTime = 0;

    // Token 指标
    this.totalTokensUsed = 0;
    this.avgTokensPerTask = 0;

    // 成功率
    this.successRate = 0;

    // 活跃度指标
    this.lastActiveAt = Date.now();
    this.totalActiveTime = 0;
    this.requestCount = 0;

    // 健康分数 (0-100)
    this.healthScore = 100;
  }

  /**
   * 计算健康分数
   */
  calculateHealthScore() {
    let score = 100;

    // 成功率影响 (最多 -30 分)
    if (this.tasksTotal > 0) {
      const failurePenalty = (1 - this.successRate) * 30;
      score -= failurePenalty;
    }

    // 任务时间影响 (最多 -20 分)
    // 如果平均任务时间超过 5 分钟，开始扣分
    if (this.avgTaskTime > 300000) {
      const timePenalty = Math.min(20, (this.avgTaskTime - 300000) / 15000);
      score -= timePenalty;
    }

    // 活跃度影响 (最多 -10 分)
    const inactiveMinutes = (Date.now() - this.lastActiveAt) / 60000;
    if (inactiveMinutes > 60) {
      const activityPenalty = Math.min(10, (inactiveMinutes - 60) / 6);
      score -= activityPenalty;
    }

    this.healthScore = Math.max(0, Math.min(100, score));
    return this.healthScore;
  }

  /**
   * 转换为 JSON
   */
  toJSON() {
    return {
      agentId: this.agentId,
      timestamp: this.timestamp,
      tasks: {
        total: this.tasksTotal,
        completed: this.tasksCompleted,
        failed: this.tasksFailed,
        cancelled: this.tasksCancelled,
        successRate: this.successRate
      },
      performance: {
        avgTaskTimeMs: Math.round(this.avgTaskTime),
        minTaskTimeMs: Math.round(this.minTaskTime === Infinity ? 0 : this.minTaskTime),
        maxTaskTimeMs: Math.round(this.maxTaskTime),
        totalTaskTimeMs: Math.round(this.totalTaskTime)
      },
      tokens: {
        total: this.totalTokensUsed,
        avgPerTask: Math.round(this.avgTokensPerTask)
      },
      activity: {
        lastActiveAt: this.lastActiveAt,
        totalActiveTimeMs: this.totalActiveTime,
        requestCount: this.requestCount
      },
      health: {
        score: Math.round(this.healthScore),
        level: this.getHealthLevel()
      }
    };
  }

  /**
   * 获取健康等级
   */
  getHealthLevel() {
    if (this.healthScore >= 90) return 'excellent';
    if (this.healthScore >= 70) return 'good';
    if (this.healthScore >= 50) return 'fair';
    if (this.healthScore >= 30) return 'poor';
    return 'critical';
  }
}

/**
 * 记录任务开始
 */
export const recordTaskStart = (agentId, taskId) => {
  if (!metricsStore.has(agentId)) {
    metricsStore.set(agentId, new MetricSnapshot(agentId));
    historyStore.set(agentId, []);
  }

  const metrics = metricsStore.get(agentId);
  metrics.tasksTotal++;
  metrics.lastActiveAt = Date.now();
  metrics.requestCount++;

  // 记录任务开始时间
  const taskKey = `${agentId}:${taskId}`;
  taskStartTime.set(taskKey, Date.now());
};

// 任务开始时间映射
const taskStartTime = new Map();

/**
 * 记录任务完成
 */
export const recordTaskComplete = (agentId, taskId, tokensUsed = 0) => {
  if (!metricsStore.has(agentId)) return;

  const metrics = metricsStore.get(agentId);
  const taskKey = `${agentId}:${taskId}`;
  const startTime = taskStartTime.get(taskKey);

  if (startTime) {
    const taskTime = Date.now() - startTime;

    // 更新时间指标
    metrics.totalTaskTime += taskTime;
    metrics.tasksCompleted++;

    if (taskTime < metrics.minTaskTime) {
      metrics.minTaskTime = taskTime;
    }
    if (taskTime > metrics.maxTaskTime) {
      metrics.maxTaskTime = taskTime;
    }

    // 计算平均时间
    if (metrics.tasksCompleted > 0) {
      metrics.avgTaskTime = metrics.totalTaskTime / metrics.tasksCompleted;
    }

    // 更新 Token 指标
    metrics.totalTokensUsed += tokensUsed;
    metrics.avgTokensPerTask = metrics.totalTokensUsed / metrics.tasksCompleted;

    // 更新成功率
    metrics.successRate = metrics.tasksCompleted / metrics.tasksTotal;

    // 计算健康分数
    metrics.calculateHealthScore();

    // 清理任务开始时间
    taskStartTime.delete(taskKey);
  }
};

/**
 * 记录任务失败
 */
export const recordTaskFailed = (agentId, taskId) => {
  if (!metricsStore.has(agentId)) return;

  const metrics = metricsStore.get(agentId);
  metrics.tasksFailed++;
  metrics.lastActiveAt = Date.now();

  // 更新成功率
  if (metrics.tasksTotal > 0) {
    metrics.successRate = metrics.tasksCompleted / metrics.tasksTotal;
  }

  // 计算健康分数
  metrics.calculateHealthScore();
};

/**
 * 记录任务取消
 */
export const recordTaskCancelled = (agentId, taskId) => {
  if (!metricsStore.has(agentId)) return;

  const metrics = metricsStore.get(agentId);
  metrics.tasksCancelled++;

  // 清理任务开始时间
  const taskKey = `${agentId}:${taskId}`;
  taskStartTime.delete(taskKey);
};

/**
 * 记录 Agent 活跃时间
 */
export const recordAgentActivity = (agentId, durationMs) => {
  if (!metricsStore.has(agentId)) return;

  const metrics = metricsStore.get(agentId);
  metrics.totalActiveTime += durationMs;
  metrics.lastActiveAt = Date.now();
};

/**
 * 获取 Agent 指标
 */
export const getAgentMetrics = (agentId) => {
  const metrics = metricsStore.get(agentId);
  if (!metrics) return null;
  return metrics.toJSON();
};

/**
 * 获取所有 Agent 指标
 */
export const getAllAgentsMetrics = () => {
  const result = [];
  for (const [agentId, metrics] of metricsStore.entries()) {
    result.push(metrics.toJSON());
  }
  return result.sort((a, b) => b.health.score - a.health.score);
};

/**
 * 保存指标快照到历史
 */
export const saveMetricsSnapshot = (agentId) => {
  const metrics = metricsStore.get(agentId);
  if (!metrics) return;

  const snapshot = metrics.toJSON();
  const history = historyStore.get(agentId) || [];

  history.push(snapshot);

  // 保留最近 100 条记录
  if (history.length > 100) {
    history.shift();
  }

  historyStore.set(agentId, history);
};

/**
 * 获取 Agent 指标历史
 */
export const getAgentMetricsHistory = (agentId, limit = 50) => {
  const history = historyStore.get(agentId) || [];
  return history.slice(-limit);
};

/**
 * 获取指标趋势
 */
export const getMetricsTrend = (agentId) => {
  const history = getAgentMetricsHistory(agentId, 10);
  if (history.length < 2) return null;

  const latest = history[history.length - 1];
  const previous = history[0];

  return {
    agentId,
    trend: {
      healthScore: latest.health.score - previous.health.score,
      successRate: latest.tasks.successRate - previous.tasks.successRate,
      avgTaskTime: latest.performance.avgTaskTimeMs - previous.performance.avgTaskTimeMs,
      tokensUsed: latest.tokens.total - previous.tokens.total
    },
    direction: latest.health.score >= previous.health.score ? 'improving' : 'declining'
  };
};

/**
 * 重置 Agent 指标
 */
export const resetAgentMetrics = (agentId) => {
  metricsStore.delete(agentId);
  historyStore.delete(agentId);
  taskStartTime.forEach((_, key) => {
    if (key.startsWith(agentId)) {
      taskStartTime.delete(key);
    }
  });
};

/**
 * 获取系统整体指标
 */
export const getSystemMetrics = () => {
  const allMetrics = getAllAgentsMetrics();

  if (allMetrics.length === 0) {
    return {
      totalAgents: 0,
      avgHealthScore: 0,
      totalTasks: 0,
      avgSuccessRate: 0,
      totalTokensUsed: 0,
      healthDistribution: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        critical: 0
      }
    };
  }

  const totalAgents = allMetrics.length;
  const avgHealthScore = allMetrics.reduce((sum, m) => sum + m.health.score, 0) / totalAgents;
  const totalTasks = allMetrics.reduce((sum, m) => sum + m.tasks.total, 0);
  const avgSuccessRate = allMetrics.reduce((sum, m) => sum + m.tasks.successRate, 0) / totalAgents;
  const totalTokensUsed = allMetrics.reduce((sum, m) => sum + m.tokens.total, 0);

  const healthDistribution = {
    excellent: allMetrics.filter(m => m.health.level === 'excellent').length,
    good: allMetrics.filter(m => m.health.level === 'good').length,
    fair: allMetrics.filter(m => m.health.level === 'fair').length,
    poor: allMetrics.filter(m => m.health.level === 'poor').length,
    critical: allMetrics.filter(m => m.health.level === 'critical').length
  };

  return {
    totalAgents,
    avgHealthScore: Math.round(avgHealthScore),
    totalTasks,
    avgSuccessRate: Math.round(avgSuccessRate * 100) / 100,
    totalTokensUsed,
    healthDistribution
  };
};

export default {
  recordTaskStart,
  recordTaskComplete,
  recordTaskFailed,
  recordTaskCancelled,
  recordAgentActivity,
  getAgentMetrics,
  getAllAgentsMetrics,
  saveMetricsSnapshot,
  getAgentMetricsHistory,
  getMetricsTrend,
  resetAgentMetrics,
  getSystemMetrics
};
