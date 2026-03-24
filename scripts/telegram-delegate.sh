#!/bin/bash
# Telegram → API Gateway 桥接脚本
# 当 Telegram 用户发送消息时，OpenClaw main agent 调用此脚本委派任务

set -e

WEBHOOK_URL="http://localhost:3000/api/v1/openclaw/delegate"
LOG_FILE="/Users/wiiclaw/openclaw-dev/api-gateway/logs/telegram-bridge.log"

# 初始化日志
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

# 检查参数
MESSAGE="$1"
SESSION_ID="$2"
USER_ID="${3:-telegram-user}"

if [ -z "$MESSAGE" ]; then
  echo "用法：telegram-delegate.sh <消息> <会话 ID> [用户 ID]"
  echo ""
  log "错误：未提供消息参数"
  exit 1
fi

log "收到 Telegram 消息：$MESSAGE"
log "会话 ID: $SESSION_ID, 用户 ID: $USER_ID"

# 调用 API Gateway webhook
RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"message\": \"$MESSAGE\",
    \"fromAgent\": \"main\",
    \"userId\": \"$USER_ID\"
  }")

# 解析响应
SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false')

if [ "$SUCCESS" = "true" ]; then
  # 提取 Agent 信息
  AGENT=$(echo "$RESPONSE" | jq -r '.selectedAgent // .subtasks[0].assignedTo // "unknown"')
  MSG=$(echo "$RESPONSE" | jq -r '.message')

  log "✅ $MSG"

  # 返回给 Telegram 用户的消息
  cat << EOF
✅ **任务已分派**

$MSG

任务详情：
- 执行 Agent: @$AGENT
- 会话 ID: \`$SESSION_ID\`

执行完成后将通知您。
EOF
else
  ERROR=$(echo "$RESPONSE" | jq -r '.error.message // "未知错误"')
  log "❌ 任务分派失败：$ERROR"

  cat << EOF
❌ **任务分派失败**

错误信息：$ERROR

请检查 API Gateway 是否正常运行。
EOF
fi
