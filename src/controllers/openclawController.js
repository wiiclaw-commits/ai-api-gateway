import winston from 'winston';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const logger = winston.createLogger();

/**
 * OpenClaw 集成控制器
 * 读取本地 OpenClaw 配置文件获取 Agent 状态
 */

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

/**
 * OpenClaw Gateway 配置（从配置文件读取）
 */
const getGatewayConfig = () => {
  try {
    const config = readOpenClawConfig();
    if (!config || !config.gateway) {
      return null;
    }
    return {
      port: config.gateway.port || 13145,
      token: config.gateway.auth?.token || null,
      baseUrl: config.gateway.baseUrl || `http://localhost:${config.gateway.port || 13145}`
    };
  } catch (error) {
    logger.error('Failed to get gateway config:', error.message);
    return null;
  }
};

/**
 * 读取 OpenClaw 配置
 */
const readOpenClawConfig = () => {
  try {
    const configPath = path.join(OPENCLAW_HOME, 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config;
  } catch (error) {
    logger.error('Failed to read OpenClaw config:', error.message);
    return null;
  }
};

/**
 * 获取 OpenClaw Agent 列表（从配置文件读取）
 */
export const getOpenClawAgents = () => {
  try {
    const config = readOpenClawConfig();
    if (!config || !config.agents || !config.agents.list) {
      return { agents: [] };
    }

    // 映射配置到标准格式
    const agents = config.agents.list
      .filter(agent => agent.id !== 'main') // 跳过 main agent
      .map(agent => ({
        id: agent.id,
        name: agent.identity?.name || agent.name || agent.id,
        emoji: agent.identity?.emoji || '',
        status: 'idle', // OpenClaw agents 默认 idle
        model: agent.model || 'unknown',
        workspace: agent.workspace,
        agentDir: agent.agentDir,
        lastActive: Date.now(),
        remote: true
      }));

    return { agents };
  } catch (error) {
    logger.error('Failed to get OpenClaw agents:', error.message);
    return { agents: [] };
  }
};

/**
 * 获取特定 Agent 状态
 */
export const getAgentStatus = (agentId) => {
  try {
    const config = readOpenClawConfig();
    if (!config || !config.agents || !config.agents.list) {
      return null;
    }

    const agent = config.agents.list.find(a => a.id === agentId);
    if (!agent) {
      return null;
    }

    return {
      id: agent.id,
      name: agent.identity?.name || agent.name || agent.id,
      emoji: agent.identity?.emoji || '',
      status: 'idle',
      model: agent.model || 'unknown',
      workspace: agent.workspace,
      agentDir: agent.agentDir,
      lastActive: Date.now(),
      remote: true
    };
  } catch (error) {
    logger.error(`Failed to get agent ${agentId} status:`, error.message);
    return null;
  }
};

/**
 * 同步 OpenClaw Agent 状态到本地存储
 */
export const syncOpenClawAgents = async (localStore) => {
  try {
    const remoteAgents = getOpenClawAgents();

    if (!remoteAgents || !remoteAgents.agents || remoteAgents.agents.length === 0) {
      return false;
    }

    // 更新本地 Agent 状态（仅当远程 agent 存在时）
    remoteAgents.agents.forEach(remoteAgent => {
      const localAgent = localStore.agents.get(remoteAgent.id);
      if (localAgent) {
        // 保持本地状态，但标记为已连接
        const previousRemote = localAgent.remote;
        localAgent.remote = true;
        localAgent.model = remoteAgent.model || localAgent.model;
        // 如果之前未连接，现在连接了，设置为 idle
        if (!previousRemote && localAgent.remote) {
          localAgent.status = 'idle';
        }
        // 如果已连接，保持 idle 状态（OpenClaw agents 默认 idle）
        if (localAgent.remote && localAgent.status === 'offline') {
          localAgent.status = 'idle';
        }
      }
    });

    return true;
  } catch (error) {
    logger.error('Failed to sync OpenClaw agents:', error.message);
    return false;
  }
};

/**
 * 获取 OpenClaw 会话列表（从内存存储读取）
 */
export const getOpenClawSessions = () => {
  // 当前实现：返回空数组，等待实际的会话管理实现
  return [];
};

/**
 * 向 OpenClaw Agent 发送消息
 */
export const sendAgentMessage = async (agentId, message, sessionId = null) => {
  try {
    const config = readOpenClawConfig();

    if (!config) {
      throw new Error('OpenClaw config not found');
    }

    // 获取 Agent 配置
    const agent = config.agents.list.find(a => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // 构建命令
    const cmd = [
      'openclaw',
      'agent',
      `--agent ${agentId}`,
      `--message "${message.replace(/"/g, '\\"')}"`,
      '--json'
    ];

    if (sessionId) {
      cmd.push(`--session-id ${sessionId}`);
    }

    const commandStr = cmd.join(' ');
    logger.info(`Executing: ${commandStr}`);

    try {
      const output = execSync(commandStr, {
        encoding: 'utf-8',
        timeout: 60000, // 60 秒超时
        env: { ...process.env, FORCE_COLOR: '0' }
      });

      logger.info(`OpenClaw agent response received`);

      // 解析 JSON 输出
      const result = JSON.parse(output);

      return {
        success: true,
        response: result.response || result.message || output,
        raw: result
      };
    } catch (execError) {
      // 命令行执行错误
      logger.error(`Command execution error:`, execError.message);
      return {
        success: false,
        error: execError.message || 'Failed to execute openclaw command'
      };
    }
  } catch (error) {
    logger.error(`Failed to send message to agent ${agentId}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * 获取 Agent 会话历史
 */
export const getAgentConversation = async (agentId, sessionId) => {
  try {
    const gatewayConfig = getGatewayConfig();
    if (!gatewayConfig) {
      throw new Error('Gateway config not found');
    }

    const url = `http://localhost:${gatewayConfig.port}/sessions/${sessionId}`;
    const response = await httpRequest(url, {
      method: 'GET',
      headers: {
        ...(gatewayConfig.token && { 'Authorization': `Bearer ${gatewayConfig.token}` })
      }
    });

    if (response.status !== 200) {
      throw new Error(`OpenClaw API error: ${response.status}`);
    }

    return response.data;
  } catch (error) {
    logger.error(`Failed to get conversation:`, error.message);
    return null;
  }
};

/**
 * 执行 OpenClaw Agent 任务
 */
export const executeAgentTask = async (agentId, task) => {
  try {
    const config = readOpenClawConfig();

    if (!config) {
      throw new Error('OpenClaw config not found');
    }

    // 获取 Agent 配置
    const agent = config.agents.list.find(a => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // 构建任务提示
    const taskPrompt = buildTaskPrompt(task);

    // 构建命令
    const cmd = [
      'openclaw',
      'agent',
      `--agent ${agentId}`,
      `--message "${taskPrompt.replace(/"/g, '\\"')}"`,
      '--json'
    ];

    if (task.sessionId) {
      cmd.push(`--session-id ${task.sessionId}`);
    }

    const commandStr = cmd.join(' ');
    logger.info(`Executing task for agent ${agentId}: ${commandStr}`);

    try {
      const output = execSync(commandStr, {
        encoding: 'utf-8',
        timeout: 300000, // 5 分钟超时
        env: { ...process.env, FORCE_COLOR: '0' }
      });

      logger.info(`Task execution completed for agent ${agentId}`);

      // 解析 JSON 输出
      const result = JSON.parse(output);

      return {
        success: true,
        result: result,
        response: extractResponseFromResult(result)
      };
    } catch (execError) {
      logger.error(`Task execution error:`, execError.message);
      return {
        success: false,
        error: execError.message || 'Failed to execute task'
      };
    }
  } catch (error) {
    logger.error(`Failed to execute task for agent ${agentId}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * 构建任务提示
 */
const buildTaskPrompt = (task) => {
  const typeLabels = {
    design: '设计任务',
    code: '开发任务',
    review: '代码审查',
    deploy: '部署任务',
    test: '测试任务',
    docs: '文档任务',
    chat: '对话任务'
  };

  const typeLabel = typeLabels[task.type] || '任务';

  let prompt = `【${typeLabel}】${task.title}\n\n`;

  if (task.description) {
    prompt += `描述：${task.description}\n\n`;
  }

  prompt += `请开始执行这个任务。`;

  return prompt;
};

/**
 * 从结果中提取响应文本
 */
const extractResponseFromResult = (result) => {
  if (result.result?.payloads?.[0]?.text) {
    return result.result.payloads[0].text;
  }
  if (result.response) {
    return result.response;
  }
  if (result.message) {
    return result.message;
  }
  return JSON.stringify(result);
};

/**
 * 定期同步任务（每 10 秒）
 */
export const startSyncLoop = async (localStore, wss, intervalMs = 10000) => {
  setInterval(async () => {
    try {
      const updated = await syncOpenClawAgents(localStore);
      // 如果有更新，发送 WebSocket 通知
      if (updated && wss) {
        for (const agent of localStore.agents.values()) {
          wss.sendAgentUpdate(agent);
        }
      }
    } catch (error) {
      logger.error('Sync loop error:', error.message);
    }
  }, intervalMs);
};

export default {
  getOpenClawAgents,
  getAgentStatus,
  syncOpenClawAgents,
  startSyncLoop,
  getOpenClawSessions,
  sendAgentMessage,
  getAgentConversation,
  executeAgentTask
};
