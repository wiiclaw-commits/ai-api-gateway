/**
 * 数据库初始化脚本
 * 自动执行 schema.sql 创建表结构
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './index.js';
import winston from 'winston';

const logger = winston.createLogger();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const initDatabase = async () => {
  let pool;

  try {
    logger.info('Connecting to database...');
    pool = getPool();

    // 读取 schema.sql
    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    logger.info('Executing database schema...');

    // 先清理现有的表结构（如果存在）
    await pool.query(`
      DROP VIEW IF EXISTS user_usage_stats CASCADE;
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      DROP TRIGGER IF EXISTS update_billing_updated_at ON billing;
      DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
      DROP TABLE IF EXISTS rate_limits CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS billing CASCADE;
      DROP TABLE IF EXISTS usage_logs CASCADE;
      DROP TABLE IF EXISTS api_keys CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS model_pricing CASCADE;
      DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // 直接执行整个 schema（PostgreSQL 支持多语句执行）
    await pool.query(schema);

    logger.info('Database schema initialized successfully');
    console.log('✅ Database initialized');

    // 创建默认管理员账户
    try {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@openclaw.dev';
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.default.hash(adminPassword, 12);

      await pool.query(
        `INSERT INTO users (email, password_hash, name, role, balance, monthly_quota)
         VALUES ($1, $2, 'System Admin', 'admin', 1000, 10000)
         ON CONFLICT (email) DO NOTHING`,
        [adminEmail, passwordHash]
      );

      console.log(`✅ Admin user created: ${adminEmail} / ${adminPassword}`);
    } catch (error) {
      console.error('❌ Failed to create admin user:', error.message);
      logger.error('Failed to create admin user', { error: error.message, stack: error.stack });
    }

    process.exit(0);
  } catch (error) {
    logger.error('Failed to initialize database:', error.message);
    console.error('❌ Database initialization failed:', error.message);
    process.exit(1);
  }
};

initDatabase();
