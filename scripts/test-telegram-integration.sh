#!/bin/bash
# Telegram → OpenClaw → API Gateway 集成测试脚本

WEBHOOK_URL="http://localhost:3000/api/v1/openclaw/delegate"

echo "╔════════════════════════════════════════════════════════╗"
echo "║   Telegram → Main Agent → API Gateway 集成测试         ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 模拟 Telegram 消息发送到 main agent
# 这个脚本可以通过 crontab 或监听器被 OpenClaw 调用

test_message() {
  local msg="$1"
  local expected_agent="$2"

  echo "📧 测试消息：$msg"
  echo "   预期分派给：$expected_agent"

  result=$(curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"sessionId\": \"test-$(date +%s)\",
      \"message\": \"$msg\",
      \"fromAgent\": \"main\",
      \"userId\": \"test-user\",
      \"chatId\": \"test-chat\"
    }")

  selected=$(echo "$result" | jq -r '.selectedAgent // .subtasks[0].assignedTo')
  echo "   实际分派给：$selected"

  if [ "$selected" == "$expected_agent" ]; then
    echo "   ✅ 正确"
  else
    echo "   ❌ 错误"
  fi
  echo ""
}

# 测试各种任务类型
test_message "帮我写一个登录页面" "frontend"
test_message "创建用户认证 API" "backend"
test_message "设计数据库架构" "architect"
test_message "配置 Docker 部署" "devops"
test_message "编写单元测试" "test"
test_message "写一篇产品文档" "ops"

echo "════════════════════════════════════════"
echo "测试完成！"
echo "════════════════════════════════════════"
