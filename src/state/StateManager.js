import { EventEmitter } from 'events';
import Redis from 'ioredis';
import pg from 'pg';
import winston from 'winston';

const logger = winston.createLogger();

/**
 * State Manager - 多 Agent 协作状态管理核心
 *
 * 功能:
 * - SessionState: 会话级状态管理
 * - AgentState: Agent 状态追踪
 * - TaskState: 任务状态追踪
 * - 并发控制：乐观锁 (CAS)、分布式锁
 * - 多级存储：Redis (L1/L2) + PostgreSQL (L3)
 */

// ==================== 数据结构 ====================

/**
 * SessionState - 会话状态
 */
class SessionState {
  constructor(sessionId, metadata = {}) {
    this.sessionId = sessionId;
    this.status = 'idle'; // idle | running | paused | completed | failed
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.metadata = metadata;
    this.agents = new Map(); // agentId -> AgentState
    this.tasks = new Map(); // taskId -> TaskState
    this.history = []; // 操作历史
    this.version = 0; // 乐观锁版本号
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: this.metadata,
      agents: Array.from(this.agents.values()).map(a => a.toJSON()),
      tasks: Array.from(this.tasks.values()).map(t => t.toJSON()),
      history: this.history.slice(-100), // 保留最近 100 条
      version: this.version
    };
  }

  static fromJSON(data) {
    const session = new SessionState(data.sessionId, data.metadata);
    session.status = data.status;
    session.createdAt = data.createdAt;
    session.updatedAt = data.updatedAt;
    data.agents?.forEach(a => {
      const agentState = AgentState.fromJSON(a);
      session.agents.set(a.agentId, agentState);
    });
    data.tasks?.forEach(t => {
      const taskState = TaskState.fromJSON(t);
      session.tasks.set(t.taskId, taskState);
    });
    session.history = data.history || [];
    session.version = data.version || 0;
    return session;
  }
}

/**
 * AgentState - Agent 状态
 */
class AgentState {
  constructor(agentId, identity = {}) {
    this.agentId = agentId;
    this.status = 'offline'; // offline | idle | busy | error
    this.identity = identity; // { name, emoji, role }
    this.currentTaskId = null;
    this.lastHeartbeat = Date.now();
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalTokens: 0,
      sessionCount: 0
    };
    this.error = null;
    this.version = 0;
  }

  toJSON() {
    return { ...this };
  }

  static fromJSON(data) {
    const agent = new AgentState(data.agentId, data.identity);
    agent.status = data.status;
    agent.currentTaskId = data.currentTaskId;
    agent.lastHeartbeat = data.lastHeartbeat;
    agent.stats = data.stats || agent.stats;
    agent.error = data.error;
    agent.version = data.version || 0;
    return agent;
  }
}

/**
 * TaskState - 任务状态
 */
class TaskState {
  constructor(taskId, type, payload = {}) {
    this.taskId = taskId;
    this.type = type; // chat | code | review | deploy | test | docs
    this.status = 'pending'; // pending | running | completed | failed | cancelled
    this.priority = 0; // 0-10, 越高优先级越高
    this.assignedTo = null; // agentId
    this.payload = payload;
    this.result = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.dependencies = []; // 依赖的 taskId 列表
    this.version = 0;
  }

  toJSON() {
    return { ...this };
  }

  static fromJSON(data) {
    const task = new TaskState(data.taskId, data.type, data.payload);
    task.status = data.status;
    task.priority = data.priority;
    task.assignedTo = data.assignedTo;
    task.result = data.result;
    task.error = data.error;
    task.createdAt = data.createdAt;
    task.startedAt = data.startedAt;
    task.completedAt = data.completedAt;
    task.dependencies = data.dependencies || [];
    task.version = data.version || 0;
    return task;
  }
}

// ==================== Redis 连接池 ====================

class RedisPool {
  constructor(config) {
    this.config = {
      host: config?.host || 'localhost',
      port: config?.port || 6379,
      db: config?.db || 0,
      password: config?.password || null,
      maxConnections: config?.maxConnections || 10,
      ...config
    };
    this.clients = [];
    this.available = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    for (let i = 0; i < this.config.maxConnections; i++) {
      const client = new Redis({
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
        password: this.config.password,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      client.on('error', (err) => logger.error('Redis client error:', err));
      client.on('connect', () => logger.info('Redis client connected'));

      await client.connect();
      this.clients.push(client);
      this.available.push(client);
    }

    this.initialized = true;
    logger.info(`Redis pool initialized with ${this.clients.length} connections`);
  }

  async acquire() {
    if (!this.initialized) await this.initialize();

    if (this.available.length === 0) {
      // 等待或创建临时连接
      return new Redis({
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
        password: this.config.password
      });
    }

    return this.available.pop();
  }

  release(client) {
    if (this.clients.includes(client)) {
      this.available.push(client);
    } else {
      client.quit().catch(() => {});
    }
  }

  async close() {
    await Promise.all(this.clients.map(c => c.quit()));
    this.clients = [];
    this.available = [];
    this.initialized = false;
  }
}

// ==================== PostgreSQL 连接池 ====================

class PostgresPool {
  constructor(config) {
    this.config = {
      host: config?.host || 'localhost',
      port: config?.port || 5432,
      database: config?.database || 'openclaw',
      user: config?.user || 'postgres',
      password: config?.password || 'postgres',
      max: config?.max || 10,
      ...config
    };
    this.pool = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    this.pool = new pg.Pool(this.config);

    this.pool.on('error', (err) => logger.error('PostgreSQL pool error:', err));

    // 初始化表结构
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        state JSONB NOT NULL,
        version BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS state_history (
        id BIGSERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        state_before JSONB,
        state_after JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_state_history_session ON state_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_state_history_created ON state_history(created_at);
    `);

    this.initialized = true;
    logger.info('PostgreSQL pool initialized');
  }

  async query(text, params) {
    if (!this.initialized) await this.initialize();
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
    this.initialized = false;
  }
}

// ==================== State Manager 主类 ====================

class StateManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      redis: config.redis || { host: 'localhost', port: 6379 },
      postgres: config.postgres || null,
      sessionTTL: config.sessionTTL || 3600000, // 1 小时
      heartbeatTimeout: config.heartbeatTimeout || 30000, // 30 秒
      ...config
    };

    this.redisPool = new RedisPool(this.config.redis);
    this.postgresPool = config.postgres ? new PostgresPool(this.config.postgres) : null;
    this.localSessions = new Map(); // 内存缓存
    this.distributedLocks = new Map(); // 分布式锁
  }

  async initialize() {
    await this.redisPool.initialize();
    if (this.postgresPool) await this.postgresPool.initialize();
    logger.info('State Manager initialized');
  }

  // ==================== Redis Key 规范 ====================

  _sessionKey(sessionId) {
    return `oc:session:${sessionId}`;
  }

  _agentKey(sessionId, agentId) {
    return `oc:agent:${sessionId}:${agentId}`;
  }

  _taskKey(sessionId, taskId) {
    return `oc:task:${sessionId}:${taskId}`;
  }

  _lockKey(resource) {
    return `oc:lock:${resource}`;
  }

  // ==================== 会话管理 ====================

  async createSession(sessionId, metadata = {}) {
    const redis = await this.redisPool.acquire();
    try {
      const session = new SessionState(sessionId, metadata);
      await this._saveSession(redis, session);
      this.localSessions.set(sessionId, session);
      this.emit('session:created', { sessionId, metadata });
      logger.info(`Session created: ${sessionId}`);
      return session;
    } finally {
      this.redisPool.release(redis);
    }
  }

  async getSession(sessionId) {
    // 1. 检查内存缓存
    const cached = this.localSessions.get(sessionId);
    if (cached && Date.now() - cached.updatedAt < this.config.sessionTTL) {
      return cached;
    }

    // 2. 从 Redis 读取
    const redis = await this.redisPool.acquire();
    try {
      const data = await redis.get(this._sessionKey(sessionId));
      if (!data) return null;

      const session = SessionState.fromJSON(JSON.parse(data));
      this.localSessions.set(sessionId, session);
      return session;
    } finally {
      this.redisPool.release(redis);
    }
  }

  async updateSession(sessionId, updater) {
    const redis = await this.redisPool.acquire();
    try {
      // 使用乐观锁更新
      let retries = 3;
      while (retries > 0) {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);

        const oldVersion = session.version;
        const result = await updater(session);

        if (result === false) return false; // 更新被取消

        session.version++;
        session.updatedAt = Date.now();

        // CAS 操作
        const saved = await this._saveSessionWithVersion(redis, session, oldVersion);
        if (saved) {
          this.localSessions.set(sessionId, session);
          this.emit('session:updated', { sessionId });
          return session;
        }

        retries--;
      }
      throw new Error('Session update failed due to version conflict');
    } finally {
      this.redisPool.release(redis);
    }
  }

  async _saveSession(redis, session) {
    const key = this._sessionKey(session.id || session.sessionId);
    await redis.setex(key, this.config.sessionTTL / 1000, JSON.stringify(session.toJSON()));
  }

  async _saveSessionWithVersion(redis, session, expectedVersion) {
    const key = this._sessionKey(session.sessionId);

    // Lua 脚本实现 CAS
    const lua = `
      local current = redis.call('GET', KEYS[1])
      if not current then return 0 end
      local data = cjson.decode(current)
      if data.version ~= tonumber(ARGV[1]) then return 0 end
      data.version = tonumber(ARGV[2])
      redis.call('SET', KEYS[1], cjson.encode(data))
      return 1
    `;

    const result = await redis.eval(lua, 1, key, expectedVersion, session.version);
    return result === 1;
  }

  async deleteSession(sessionId) {
    const redis = await this.redisPool.acquire();
    try {
      await redis.del(this._sessionKey(sessionId));
      this.localSessions.delete(sessionId);
      this.emit('session:deleted', { sessionId });
    } finally {
      this.redisPool.release(redis);
    }
  }

  // ==================== Agent 状态管理 ====================

  async registerAgent(sessionId, agentId, identity = {}) {
    return this.updateSession(sessionId, async (session) => {
      if (!session.agents.has(agentId)) {
        const agentState = new AgentState(agentId, identity);
        session.agents.set(agentId, agentState);
        this.emit('agent:registered', { sessionId, agentId, identity });
      }
    });
  }

  async updateAgentStatus(sessionId, agentId, status, error = null) {
    return this.updateSession(sessionId, async (session) => {
      const agent = session.agents.get(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      agent.status = status;
      agent.lastHeartbeat = Date.now();
      agent.error = error;
    });
  }

  async agentHeartbeat(sessionId, agentId) {
    return this.updateSession(sessionId, async (session) => {
      const agent = session.agents.get(agentId);
      if (!agent) return false;
      agent.lastHeartbeat = Date.now();
    });
  }

  // ==================== 任务管理 ====================

  async createTask(sessionId, task) {
    return this.updateSession(sessionId, async (session) => {
      session.tasks.set(task.taskId, task);
      session.history.push({
        action: 'task:created',
        taskId: task.taskId,
        timestamp: Date.now()
      });
      this.emit('task:created', { sessionId, task });
    });
  }

  async assignTask(sessionId, taskId, agentId) {
    return this.updateSession(sessionId, async (session) => {
      const task = session.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.assignedTo = agentId;
      task.status = 'running';
      task.startedAt = Date.now();

      const agent = session.agents.get(agentId);
      if (agent) {
        agent.status = 'busy';
        agent.currentTaskId = taskId;
      }
    });
  }

  async completeTask(sessionId, taskId, result) {
    return this.updateSession(sessionId, async (session) => {
      const task = session.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'completed';
      task.result = result;
      task.completedAt = Date.now();

      if (task.assignedTo) {
        const agent = session.agents.get(task.assignedTo);
        if (agent) {
          agent.status = 'idle';
          agent.currentTaskId = null;
          agent.stats.tasksCompleted++;
        }
      }
    });
  }

  async failTask(sessionId, taskId, error) {
    return this.updateSession(sessionId, async (session) => {
      const task = session.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      task.status = 'failed';
      task.error = error;
      task.completedAt = Date.now();

      if (task.assignedTo) {
        const agent = session.agents.get(task.assignedTo);
        if (agent) {
          agent.status = 'error';
          agent.currentTaskId = null;
          agent.stats.tasksFailed++;
          agent.error = error;
        }
      }
    });
  }

  // ==================== 分布式锁 ====================

  async acquireLock(resource, ttl = 10000) {
    const redis = await this.redisPool.acquire();
    const lockKey = this._lockKey(resource);
    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Lua 脚本：原子性设置锁
    const lua = `
      if redis.call('EXISTS', KEYS[1]) == 0 then
        redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
        return 1
      end
      return 0
    `;

    const result = await redis.eval(lua, 1, lockKey, lockId, Math.ceil(ttl / 1000));
    this.redisPool.release(redis);

    if (result === 1) {
      this.distributedLocks.set(resource, { lockId, acquiredAt: Date.now() });
      return { lockId, resource };
    }
    return null;
  }

  async releaseLock(resource) {
    const lock = this.distributedLocks.get(resource);
    if (!lock) return false;

    const redis = await this.redisPool.acquire();
    const lockKey = this._lockKey(resource);

    // 验证并删除锁
    const currentValue = await redis.get(lockKey);
    if (currentValue === lock.lockId) {
      await redis.del(lockKey);
      this.distributedLocks.delete(resource);
      this.redisPool.release(redis);
      return true;
    }

    this.redisPool.release(redis);
    return false;
  }

  // ==================== 持久化到 PostgreSQL ====================

  async persistToPostgres(sessionId) {
    if (!this.postgresPool) return;

    const session = await this.getSession(sessionId);
    if (!session) return;

    await this.postgresPool.query(
      `INSERT INTO sessions (session_id, state, version, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (session_id) DO UPDATE
       SET state = $2, version = $3, updated_at = NOW()`,
      [sessionId, JSON.stringify(session.toJSON()), session.version]
    );
  }

  // ==================== 清理 ====================

  async close() {
    await this.redisPool.close();
    if (this.postgresPool) await this.postgresPool.close();
    this.localSessions.clear();
    this.removeAllListeners();
    logger.info('State Manager closed');
  }
}

export { StateManager, SessionState, AgentState, TaskState, RedisPool, PostgresPool };
export default StateManager;
