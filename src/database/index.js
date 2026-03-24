/**
 * PostgreSQL 数据库连接管理
 */
import pkg from 'pg';
const { Pool } = pkg;
import winston from 'winston';

const logger = winston.createLogger();

// 数据库连接配置（延迟初始化）
let poolConfig = null;

const getPoolConfig = () => {
  if (!poolConfig) {
    poolConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'openclaw_dev',
      user: process.env.DB_USER || 'openclaw',
      password: String(process.env.DB_PASSWORD || ''),
      max: parseInt(process.env.DB_POOL_SIZE || '20'),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };
    logger.info('Database pool config initialized', {
      host: poolConfig.host,
      port: poolConfig.port,
      database: poolConfig.database,
      user: poolConfig.user,
      passwordSet: poolConfig.password.length > 0
    });
  }
  return poolConfig;
};

// 创建连接池
let pool = null;

/**
 * 初始化数据库连接池
 */
export const initDatabase = () => {
  try {
    pool = new Pool(getPoolConfig());

    pool.on('error', (err) => {
      logger.error('Unexpected database pool error:', err.message);
    });

    pool.on('connect', () => {
      logger.info('New database client connected');
    });

    logger.info('Database pool initialized', {
      host: poolConfig.host,
      port: poolConfig.port,
      database: poolConfig.database
    });

    return pool;
  } catch (error) {
    logger.error('Failed to initialize database:', error.message);
    throw error;
  }
};

/**
 * 获取数据库连接池
 */
export const getPool = () => {
  if (!pool) {
    return initDatabase();
  }
  return pool;
};

/**
 * 获取数据库连接（用于事务）
 */
export const getClient = async () => {
  const p = getPool();
  const client = await p.connect();

  // 自动释放连接
  const release = () => client.release();

  return {
    client,
    release,
    query: async (text, params) => {
      try {
        return await client.query(text, params);
      } catch (error) {
        throw error;
      }
    },
    // 开始事务
    beginTransaction: async () => {
      await client.query('BEGIN');
    },
    // 提交事务
    commit: async () => {
      await client.query('COMMIT');
      release();
    },
    // 回滚事务
    rollback: async () => {
      await client.query('ROLLBACK');
      release();
    }
  };
};

/**
 * 执行查询
 */
export const query = async (text, params) => {
  const p = getPool();
  const start = Date.now();

  try {
    const result = await p.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Query error:', { text, error: error.message });
    throw error;
  }
};

/**
 * 关闭数据库连接
 */
export const closeDatabase = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
};

export default {
  initDatabase,
  getPool,
  getClient,
  query,
  closeDatabase
};
