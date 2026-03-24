# Telegram + OpenClaw 多 Agent 协作指南

## 架构概述

```
Telegram Bot → OpenClaw Gateway (13145) → 项目经理 (main agent)
                                             ↓
                                    API Gateway (3000)
                                             ↓
         架构师 | 前端 | 后端 | DevOps | 测试 | 运营
```

## 配置步骤

### 1. 确保 OpenClaw Gateway 运行中

```bash
# 检查 Gateway 状态
curl http://127.0.0.1:13145/health

# 返回：{"ok":true,"status":"live"} 表示正常
```

### 2. 确保 API Gateway 运行中

```bash
# 启动 API Gateway
npm start

# 检查状态
curl http://localhost:3000/health
```

### 3. Telegram 接入

OpenClaw 已配置 Telegram 集成（见 `~/.openclaw/openclaw.json`）:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "groupPolicy": "open",
      "streaming": "partial"
    }
  }
}
```

Telegram Bot 会自动将消息转发给 **项目经理 (main agent)**。

## 使用方式

### 直接发送任务

在 Telegram 中直接发送任务描述：

```
帮我创建一个用户注册功能
```

项目经理会自动：
1. 分析任务类型
2. 选择最合适的 Agent（后端开发）
3. 通过 webhook 委派给 API Gateway
4. API Gateway 创建任务并分派

### 指定 Agent 类型

使用 `[Agent 名]` 前缀指定执行者：

```
[前端] 创建一个登录页面，包含邮箱和密码输入框
[后端] 实现 JWT 用户认证 API
[DevOps] 配置 Docker Compose 部署 PostgreSQL
[测试] 为登录功能编写单元测试
[运营] 写一篇产品介绍文案
```

### 复杂任务（多 Agent 协作）

描述涉及多个领域的复杂任务：

```
开发一个完整的博客系统，包括：
- 前端 React 界面
- 后端 Node.js API
- PostgreSQL 数据库
- Docker 部署配置
```

API Gateway 会自动：
1. 分解任务为 4 个子任务
2. 分派给对应的专业 Agent
3. 管理任务依赖（先设计 → 再开发 → 最后测试）
4. 汇总结果

## API 端点

### 委派任务

```bash
POST http://localhost:3000/api/v1/openclaw/delegate

Content-Type: application/json

{
  "sessionId": "telegram-session-xxx",
  "message": "创建一个用户登录 API",
  "fromAgent": "main",
  "userId": "telegram-user-123",
  "chatId": "chat-456"
}
```

响应：
```json
{
  "success": true,
  "message": "任务已分派给 backend Agent",
  "task": {
    "taskId": "webhook-task-1",
    "sessionId": "telegram-session-xxx",
    "type": "chat",
    "title": "Telegram: 创建一个用户登录 API",
    "status": "pending",
    "assignedTo": "backend",
    "priority": 7
  },
  "sessionId": "telegram-session-xxx",
  "selectedAgent": "backend"
}
```

### 获取 Agent 状态

```bash
GET http://localhost:3000/api/v1/openclaw/agents/status
```

### 查询任务状态

```bash
GET http://localhost:3000/api/v1/openclaw/tasks/:id/status
```

## 任务类型自动识别

系统根据关键词自动选择 Agent：

| 关键词 | 分派给 |
|--------|--------|
| 架构、设计、system-design | 架构师 |
| 前端、UI、组件、React、Vue | 前端开发 |
| 后端、API、数据库、Node.js | 后端开发 |
| 部署、Docker、CI/CD、云 | DevOps |
| 测试、Bug、调试 | 测试工程师 |
| 文档、内容、运营 | 运营专家 |

## WebSocket 实时监控

连接 WebSocket 查看实时任务进度：

```
ws://localhost:3000/ws
```

订阅后会收到：
- 任务创建通知
- 任务状态更新
- Agent 状态变化
- 日志消息

## 查看任务历史

```bash
# 获取所有任务
GET http://localhost:3000/api/v1/tasks

# 获取特定会话的任务
GET http://localhost:3000/api/v1/tasks?sessionId=telegram-session-xxx

# 获取已完成的任务
GET http://localhost:3000/api/v1/tasks?status=completed
```

## 示例对话流程

### 用户发送
```
帮我开发一个待办事项应用
```

### 项目经理回复
```
收到您的任务：「开发一个待办事项应用」

经过分析，这个任务需要：
- 架构师 Agent 设计数据模型
- 前端开发 Agent 创建 React 界面
- 后端开发 Agent 实现 REST API
- 测试工程师 Agent 编写测试用例

任务已分解为 4 个子任务并开始执行...
```

### 执行过程
1. 架构师设计 Todo 数据模型
2. 后端开发实现 CRUD API
3. 前端开发创建 UI 组件
4. 测试工程师编写单元测试

### 最终结果
```
✅ 待办事项应用开发完成！

已完成：
1. 数据模型设计（架构师）
2. REST API 实现（后端）
3. React 界面（前端）
4. 单元测试（测试）

访问地址：http://localhost:5173
API 文档：http://localhost:3000/api/v1/docs
```

## 故障排查

### Telegram 消息未响应
1. 检查 OpenClaw Gateway 状态
2. 检查 Telegram Bot Token 是否正确
3. 查看 OpenClaw 日志

### 任务未分派
1. 检查 API Gateway 是否运行
2. 查看 webhook 端点是否可达
3. 检查 API Gateway 日志

### Agent 未执行
1. 检查 Agent 状态（idle/busy/error）
2. 查看任务队列状态
3. 检查 WebSocket 推送是否正常

## 高级配置

### 修改 Agent 选择逻辑

编辑 `src/controllers/openclawWebhook.js` 中的 `TASK_AGENT_MAP` 和 `KEYWORD_TASK_TYPE_MAP`。

### 自定义任务分解策略

编辑 `decomposeTask()` 函数，实现更智能的任务分解逻辑。

### 添加新的 Agent

1. 在 `~/.openclaw/openclaw.json` 中添加新 Agent
2. 在 `src/routes/agents.js` 中注册
3. 在 `openclawWebhook.js` 中添加映射关系
