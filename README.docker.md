# OpenClaw API Gateway Docker 部署指南

## 快速开始

### 1. 配置环境变量

```bash
# 复制环境变量文件
cp .env.docker .env

# 编辑 .env 文件，配置必要的变量
# - BAILIAN_API_KEY (必填)
# - JWT_SECRET (生产环境请修改)
# - DB_PASSWORD (生产环境请修改)
```

### 2. 启动所有服务

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 3. 初始化数据库

```bash
# 首次启动时需要初始化数据库
docker-compose exec api-gateway npm run db:init
```

### 4. 访问服务

| 服务 | 地址 | 说明 |
|------|------|------|
| API Gateway | http://localhost:3000 | API 服务 |
| Web Frontend | http://localhost:5173 | 前端界面 |
| PostgreSQL | localhost:5432 | 数据库 |
| Redis | localhost:6379 | 缓存 |

### 5. 默认管理员账号

- Email: `admin@openclaw.dev`
- Password: `admin123`

**⚠️ 首次登录后请立即修改密码！**

## 服务说明

### PostgreSQL
- 数据持久化在 `postgres_data` 卷
- 自动执行 `database/schema.sql` 初始化

### Redis
- 用于分布式速率限制
- 数据持久化在 `redis_data` 卷

### API Gateway
- 依赖 PostgreSQL 和 Redis
- 自动重试连接
- 健康检查：`/health`

### Web Frontend
- Vite 开发服务器
- 自动热重载

## 常用命令

```bash
# 查看服务状态
docker-compose ps

# 重启某个服务
docker-compose restart api-gateway

# 查看日志
docker-compose logs -f api-gateway

# 进入容器
docker-compose exec api-gateway sh

# 数据库备份
docker-compose exec postgres pg_dump -U openclaw openclaw_dev > backup.sql

# 数据库恢复
docker-compose exec -T postgres psql -U openclaw openclaw_dev < backup.sql

# 清理所有数据（危险！）
docker-compose down -v
```

## OpenClaw Agents 集成

API Gateway 会读取 `~/.openclaw/openclaw.json` 配置文件获取 Agent 列表。

确保：
1. OpenClaw 已安装并配置
2. `~/.openclaw/openclaw.json` 存在
3. Docker 卷挂载正确配置

## 生产环境建议

1. **修改默认密码**
   - `DB_PASSWORD`
   - `JWT_SECRET`
   - `ADMIN_PASSWORD`

2. **启用 HTTPS**
   - 使用 Nginx 反向代理
   - 配置 SSL 证书

3. **配置 Redis 密码**
   - 在 `docker-compose.yml` 中添加 `REDIS_PASSWORD`

4. **日志管理**
   - 配置日志轮转
   - 使用 ELK 或类似工具集中管理

5. **监控告警**
   - 配置 Prometheus + Grafana
   - 监控容器健康状态

## 故障排查

### API Gateway 无法启动

```bash
# 检查日志
docker-compose logs api-gateway

# 检查依赖服务
docker-compose ps
```

### 数据库连接失败

```bash
# 测试数据库连接
docker-compose exec postgres pg_isready -U openclaw

# 查看数据库日志
docker-compose logs postgres
```

### Redis 连接失败

```bash
# 测试 Redis 连接
docker-compose exec redis redis-cli ping

# 查看 Redis 日志
docker-compose logs redis
```
