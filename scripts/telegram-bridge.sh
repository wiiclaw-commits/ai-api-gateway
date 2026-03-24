#!/bin/bash
# OpenClaw Telegram → API Gateway 桥接脚本
# 使用方法：将此脚本配置为 OpenClaw main agent 的回调工具

WEBHOOK_URL="http://localhost:3000/api/v1/openclaw/delegate"
LOG_FILE="/Users/wiiclaw/openclaw-dev/api-gateway/logs/telegram-bridge.log"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

# 从 OpenClaw 接收消息并转发到 API Gateway
delegate_task() {
  local message="$1"
  local session_id="$2"
  local user_id="$3"

  log "收到任务委派请求：$message"

  response=$(curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"sessionId\": \"$session_id\",
      \"message\": \"$message\",
      \"fromAgent\": \"main\",
      \"userId\": \"$user_id\"
    }")

  success=$(echo "$response" | jq -r '.success')
  if [ "$success" == "true" ]; then
    agent=$(echo "$response" | jq -r '.selectedAgent // .subtasks[0].assignedTo')
    log "任务已分派给：$agent"
    echo "✅ 任务已分派给 @$agent Agent"
  else
    error=$(echo "$response" | jq -r '.error.message')
    log "任务分派失败：$error"
    echo "❌ 任务分派失败：$error"
  fi
}

# 导出函数供 OpenClaw 调用
export -f delegate_task log
export WEBHOOK_URL LOG_FILE

# 如果直接执行，测试连接
if [ -z "$1" ]; then
  echo "Telegram → API Gateway 桥接服务"
  echo "使用方法：delegate_task '任务描述' '会话 ID' '用户 ID'"
  echo ""
  log "桥接服务已启动"
else
  delegate_task "$@"
fi
