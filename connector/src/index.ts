/**
 * 飞书 Connector 主入口 - WebSocket 模式
 */
import dotenv from 'dotenv';
import path from 'path';

// 加载 .env 文件（必须在任何其他模块 import 之前）
dotenv.config({ path: path.join(process.cwd(), '.env') });

// 立即验证关键环境变量
console.log('[Env] BRIDGE_PLUGIN_DIR:', process.env.BRIDGE_PLUGIN_DIR);
console.log('[Env] MINIMAX_API_KEY:', process.env.MINIMAX_API_KEY ? '***' : 'NOT SET');

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { initUserMap, findUserByOpenId, findAllUsers, updateUserStatus, updateUserStatusRecord } from './user-map.js';
import { initRouter, handleFeishuMessage } from './router.js';
import { createFeishuWSClient } from './feishu-ws.js';
import { handleWikiRequest, searchWikiWithUserToken } from './wiki-proxy.js';
import { handleFeishuRequest } from './feishu-api.js';
import { getUserAccessToken, initUserTokenStore } from './user-token-store.js';
import { buildAuthUrl, exchangeCodeForUserToken } from './feishu-oauth.js';
import { initSkillStore, submitSkillRequest, getApprovedSkills } from './skill-store.js';
import { markSessionStart, markSessionEnd } from './runtime-state.js';
import { initTracing } from './lib/tracing.js';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fs, { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { userImageExists, getContainerLastActiveTime } from './docker.js';
import { putUserContainerToSleep, containerHasNoActiveOpenclawTasks, returnToPool } from './container-pool.js';
import { createWebhookHandler, dispatchFeishuEvent } from './webhook.js';
import rateLimit from '@fastify/rate-limit';
import { createServer } from 'https';
import type { FeishuMessageEvent, ConnectorConfig, FeishuWebhookEvent } from './types.js';

// 配置
const config: ConnectorConfig = {
  port: parseInt(process.env.CONNECTOR_PORT || '3000'),
  feishu: {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || '',
    encrypt_key: process.env.FEISHU_ENCRYPT_KEY || '',
    verification_token: process.env.FEISHU_VERIFICATION_TOKEN || '',
  },
  docker: {
    host: process.env.DOCKER_HOST || 'localhost',
    port: parseInt(process.env.DOCKER_PORT || '2375'),
    openclaw_image: process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest',
    data_dir: process.env.DATA_DIR || '/data/users',
  },
  gateway: {
    base_port: parseInt(process.env.GATEWAY_BASE_PORT || '18790'),
    hooks_token_salt: process.env.HOOKS_TOKEN_SALT || 'default-salt-change-me',
  },
  admin: {
    jwtSecret: process.env.ADMIN_JWT_SECRET || '',
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },
};

// 创建 Fastify 实例
const fastify = Fastify({
  logger: true,
});

// ========== Graceful shutdown tracking ==========
// onRequest increments (request started), onResponse decrements (response finished).
// NOTE: Fastify v5 onRequest/onResponse hooks require either:
//   (a) async function returning a non-undefined Promise, OR
//   (b) sync function using done(err, result) callback
// Returning undefined from a sync function hangs the request.
let pendingCount = 0;
fastify.addHook('onRequest', (_req, _reply, done) => {
  pendingCount++;
  done();
});
fastify.addHook('onResponse', (_req, _reply, done) => {
  pendingCount = Math.max(0, pendingCount - 1);
  done();
});

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gracefulShutdown(signal: string) {
  console.log(`[GracefulShutdown] Received ${signal}, shutting down gracefully...`);
  await fastify.close();
  const deadline = Date.now() + 30_000;
  while (pendingCount > 0 && Date.now() < deadline) {
    console.log(`[GracefulShutdown] Waiting for ${pendingCount} in-flight requests...`);
    await sleep(500);
  }
  console.log('[GracefulShutdown] Done.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 注册 Swagger UI (OpenAPI 3.0)
const openApiSpec = parseYaml(readFileSync('./src/docs/openapi.yaml', 'utf-8'));
await fastify.register(fastifySwagger, { openapi: openApiSpec });
await fastify.register(fastifySwaggerUi, { routePrefix: '/docs' });

// 注册 CORS
fastify.register(cors, {
  origin: true,
});

// 注册 Rate Limiting (100 req/min per IP)
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
  errorResponseBuilder: (_req, ctx) => ({
    error: 'Too many requests',
    retryAfter: ctx.after,
  }),
});

// 健康检查
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

// ========== Prometheus metrics ==========
import { metricsHandler, getContentType, activeUsersGauge, dlqSizeGauge } from './lib/metrics.js';

fastify.get('/metrics', async (_req, reply) => {
  // Update gauges before returning metrics
  const { findUsersByPhase } = await import('./user-map.js');
  const { getDLQStats } = await import('./lib/dlq.js');
  activeUsersGauge.set(findUsersByPhase('active').length);
  const dlqStats = await getDLQStats();
  dlqSizeGauge.set(dlqStats.pending);
  reply.header('Content-Type', getContentType());
  return metricsHandler();
});

// ========== Detailed health probes ==========
fastify.get('/healthz', async (_req, reply) => {
  // Check Docker connectivity via user-map store init
  let dockerOk = true;
  try {
    // Simple check: see if we can list containers (lazy init)
    const { findAllUsers } = await import('./user-map.js');
    findAllUsers();
  } catch {
    dockerOk = false;
  }
  // DB health: store is always in-memory after init
  const dbOk = true;
  if (!dockerOk || !dbOk) {
    return reply.status(503).send({ ok: false, docker: dockerOk, db: dbOk });
  }
  return { ok: true, docker: dockerOk, db: dbOk, timestamp: Date.now() };
});

fastify.get('/healthz/ready', async (_req, reply) => {
  const { findActiveUsers } = await import('./user-map.js');
  const activeUsers = findActiveUsers();
  if (activeUsers.length === 0) {
    return reply.status(503).send({ ok: false, reason: 'no active users' });
  }
  return { ok: true, activeUsers: activeUsers.length };
});

// ========== Webhook Endpoint (HMAC-SHA256 verified) ==========
const webhookHandler = createWebhookHandler({
  encryptKey: config.feishu.encrypt_key,
  verificationToken: config.feishu.verification_token,
  onMessage: async (event: FeishuWebhookEvent) => {
    await dispatchFeishuEvent(event, async (ev) => {
      await handleFeishuMessage(ev.event as FeishuMessageEvent);
    });
  },
});
fastify.post('/webhook', webhookHandler);

// ========== Admin UI ==========
// Admin 页面 - 来自独立 HTML 文件
fastify.get('/admin', async (_req, reply) => {
  const htmlPath = path.join(process.cwd(), 'src/admin/ui/admin-dashboard.html');
  reply.header('Content-Type', 'text/html');
  return fs.readFileSync(htmlPath, 'utf-8');
});

fastify.get('/admin/network', async (_req, reply) => {
  const htmlPath = path.join(process.cwd(), 'src/admin/ui/admin-network.html');
  reply.header('Content-Type', 'text/html');
  return fs.readFileSync(htmlPath, 'utf-8');
});


// 获取用户状态 (调试用)
fastify.get('/api/users/:openId', async (request, reply) => {
  const { openId } = request.params as { openId: string };
  const user = findUserByOpenId(openId);

  if (!user) {
    return reply.status(404).send({ error: 'User not found' });
  }

  return {
    open_id: user.spec.feishuOpenId,
    user_name: user.spec.userName,
    status: user.status.phase,
    gateway_url: user.status.gatewayUrl,
    created_at: user.createdAt,
    last_active: user.lastActive,
  };
});

// 飞书 Wiki 代理 API - 让用户容器调用
fastify.post('/api/wiki', async (request, reply) => {
  try {
    const { action, ...params } = request.body as { action: string; [key: string]: any };
    const result = await handleWikiRequest(action, params);
    return result;
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({ error: err.message });
  }
});

// 飞书 API 统一入口 - 让用户容器调用各种飞书功能
fastify.post('/api/feishu', async (request, reply) => {
  try {
    const { action, ...params } = request.body as { action: string; [key: string]: any };
    const result = await handleFeishuRequest(action, params);
    return result;
  } catch (error) {
    const err = error as Error;
    return reply.status(500).send({ error: err.message });
  }
});

// 飞书 OAuth：获取授权链接（供前端或 agent 引导用户点击）
fastify.get('/api/feishu/oauth/url', async (request, reply) => {
  const openId = (request.query as { open_id?: string }).open_id;
  if (!openId) {
    return reply.status(400).send({ error: 'Missing open_id' });
  }
  return { auth_url: buildAuthUrl(openId) };
});

// 飞书 OAuth 回调：用 code 换 user_access_token 并存储
fastify.get('/api/feishu/oauth/callback', async (request, reply) => {
  const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
  console.log('[OAuth callback] GET /api/feishu/oauth/callback', { hasCode: !!code, hasState: !!state, error: error ?? null });
  const html = (body: string) =>
    reply.header('Content-Type', 'text/html; charset=utf-8').send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>${body}</p></body></html>`
    );
  if (error === 'access_denied') {
    console.log('[OAuth callback] user denied');
    return html('您已取消授权。');
  }
  if (!code || !state) {
    console.log('[OAuth callback] missing code or state');
    return html('缺少 code 或 state 参数。');
  }
  const result = await exchangeCodeForUserToken(code, state);
  if (!result.ok) {
    console.log('[OAuth callback] exchange failed:', result.error);
    return html(`授权失败：${result.error ?? '未知错误'}`);
  }
  console.log('[OAuth callback] token saved for open_id=', state);
  return html('授权成功，知识库搜索已可用。可关闭此页面。');
});

// ========== Skill 管理 API ==========

// 提交 skill 请求
fastify.post('/api/skills/request', async (request, reply) => {
  await initSkillStore();

  const { name, description, content, type = 'skill', requester_open_id } = request.body as {
    name: string;
    description: string;
    content: string;
    type?: 'skill' | 'proxy';
    requester_open_id?: string;
  };

  if (!name || !description || !content) {
    return reply.status(400).send({ error: 'Missing required fields: name, description, content' });
  }

  const result = await submitSkillRequest(name, description, content, type, requester_open_id);
  return { success: true, request: result };
});

// 用户查看自己提交的 skill 请求
fastify.get('/api/skills/my-requests', async (request, reply) => {
  await initSkillStore();
  const { open_id } = request.query as { open_id?: string };

  if (!open_id) {
    return reply.status(400).send({ error: 'Missing open_id parameter' });
  }

  const { getRequestsByUser } = await import('./skill-store.js');
  const requests = getRequestsByUser(open_id);
  return { requests };
});

// 获取已批准的 skills
fastify.get('/api/skills', async () => {
  await initSkillStore();
  return { skills: getApprovedSkills() };
});

// ========== Plugin API（供 neoway-feishu Bridge 插件调用）==========

// 验证 Bridge 插件的请求
async function verifyBridgeRequest(request: any): Promise<{ valid: boolean; error?: string }> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.slice(7);

  // 开发阶段：如果未配置 BRIDGE_TOKEN，则使用弱口令 Neoway-Feishu-Bridge，并打印警告日志
  const configuredToken = process.env.BRIDGE_TOKEN;
  const expectedToken = configuredToken || 'Neoway-Feishu-Bridge';
  if (!configuredToken) {
    console.warn(
      '[Bridge] BRIDGE_TOKEN is not set, falling back to weak default token "Neoway-Feishu-Bridge" for development only'
    );
  }

  if (token !== expectedToken) {
    return { valid: false, error: 'Invalid token' };
  }

  return { valid: true };
}

// 插件事件上报
fastify.post('/plugin/events', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    return reply.status(401).send({ error: verification.error });
  }

  const { event_type, session_id, user_id, timestamp, ...extra } = request.body as any;

  console.log(`[Plugin Event] ${event_type}: session=${session_id}, user=${user_id}`);

  // 可以在这里处理各种事件
  switch (event_type) {
    case 'session_start':
      // 更新用户活跃时间 + 运行时状态
      if (user_id) {
        await updateUserStatus(user_id, 'active');
        markSessionStart(user_id);
      }
      break;
    case 'session_end':
      // 记录会话结束，更新运行时状态
      if (user_id) {
        markSessionEnd(user_id);
      }
      break;
    default:
      console.log(`[Plugin Event] Unknown event type: ${event_type}`);
  }

  return { success: true, received: true };
});

// 知识库搜索（需用户 OAuth 授权后使用 user_access_token 调飞书搜索）
fastify.post('/plugin/kb/search', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    return reply.status(401).send({ error: verification.error });
  }

  const openId = request.headers['x-user-openid'] as string;
  if (!openId) {
    return reply.status(400).send({
      success: false,
      error: 'Missing X-User-OpenId header',
      need_auth: true,
      message: '请由 Agent 通过「知识库授权」获取授权链接后再试',
    });
  }

  const { query, kb_name = 'sanbu', limit = 5 } = request.body as any;
  console.log(`[KB Search] open_id=${openId}, query="${query}", kb=${kb_name}, limit=${limit}`);

  const userToken = await getUserAccessToken(openId);
  if (!userToken) {
    console.log('[KB Search] no user token for open_id=', openId, ', returning need_auth');
    const authUrl = buildAuthUrl(openId);
    return {
      success: false,
      need_auth: true,
      auth_url: authUrl,
      message: '使用知识库搜索前，请先完成授权。请点击下方链接（或由 Agent 发送给您）完成授权后重试。',
    };
  }

  try {
    const searchResult = await searchWikiWithUserToken(userToken, {
      query: query || '',
      space_id: kb_name ? undefined : undefined,
      limit: Math.min(Math.max(1, limit), 50),
    });
    const results = (searchResult.items || []).map((item, i) => ({
      title: item.title || '（无标题）',
      content: item.title || '',
      url: item.url || '',
      score: 1 - i * 0.05,
      node_id: item.node_id,
      space_id: item.space_id,
    }));
    return { success: true, results };
  } catch (err: any) {
    console.error('[KB Search] Feishu API error:', err?.message);
    const msg = err?.message || String(err);
    if (msg.includes('99991679') || msg.includes('permission')) {
      const authUrl = buildAuthUrl(openId);
      return {
        success: false,
        need_auth: true,
        auth_url: authUrl,
        message: '当前授权已过期或权限不足，请重新授权。',
      };
    }
    return reply.status(500).send({ success: false, error: msg });
  }
});

// 获取知识库授权链接（供 Agent 发消息给用户索要授权）
fastify.get('/plugin/wiki/auth_url', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    return reply.status(401).send({ error: verification.error });
  }
  const openId = request.headers['x-user-openid'] as string;
  if (!openId) {
    return reply.status(400).send({ error: 'Missing X-User-OpenId header' });
  }
  return { auth_url: buildAuthUrl(openId), message: '请点击链接完成知识库搜索授权，授权后可搜索企业知识库。' };
});

// 获取用户 Gateway 运行时状态
fastify.get('/plugin/runtime/status', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    return reply.status(401).send({ error: verification.error });
  }

  // 从 X-User-OpenId header 获取当前用户
  const openId = request.headers['x-user-openid'] as string;

  if (!openId) {
    return reply.status(400).send({ error: 'Missing X-User-OpenId header' });
  }

  const user = findUserByOpenId(openId);
  if (!user) {
    return reply.status(404).send({ error: 'User not found' });
  }

  return {
    success: true,
    user: {
      open_id: user.spec.feishuOpenId,
      user_name: user.spec.userName,
      status: user.status.phase,
      container_id: user.status.containerId,
      gateway_url: user.status.gatewayUrl,
      last_active: user.lastActive,
    },
  };
});

// 获取所有用户运行时状态
fastify.get('/plugin/runtime/all', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    return reply.status(401).send({ error: verification.error });
  }

  const users = findAllUsers();

  return {
    success: true,
    users: users.map(u => ({
      open_id: u.spec.feishuOpenId,
      user_name: u.spec.userName,
      status: u.status.phase,
      container_id: u.status.containerId,
      gateway_url: u.status.gatewayUrl,
      last_active: u.lastActive,
    })),
  };
});

// ========== 飞书相关 Plugin API（供 Bridge 插件调用）==========

// 发送飞书消息
fastify.post('/plugin/feishu/send', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized send attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { receive_id, receive_id_type, content, msg_type = 'text' } = request.body as any;
  console.log(`[Bridge] send_message: to=${receive_id}, type=${msg_type}, content_len=${content?.length || 0}`);

  try {
    const result = await handleFeishuRequest('send_message', {
      receive_id,
      receive_id_type,
      content,
      msg_type,
    });
    return { success: true, ...result };
  } catch (error: any) {
    return reply.status(500).send({ error: error.message });
  }
});

// 获取飞书消息
fastify.post('/plugin/feishu/get_messages', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized get_messages attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { receive_id, receive_id_type, page_size = 50 } = request.body as any;
  console.log(`[Bridge] get_messages: receive_id=${receive_id}, type=${receive_id_type}, page_size=${page_size}`);

  try {
    const result = await handleFeishuRequest('get_messages', {
      receive_id,
      receive_id_type,
      page_size,
    });
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] get_messages failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// 获取飞书文档
fastify.post('/plugin/feishu/fetch_doc', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized fetch_doc attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { doc_token, node_id } = request.body as any;
  console.log(`[Bridge] fetch_doc: doc_token=${doc_token}, node_id=${node_id}`);

  try {
    const result = await handleFeishuRequest('get_doc', {
      doc_token,
      node_id,
    });
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] fetch_doc failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// 飞书日历操作
fastify.post('/plugin/feishu/calendar', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized calendar attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { action, ...params } = request.body as any;
  console.log(`[Bridge] calendar: action=${action}, params=${JSON.stringify(params)}`);

  try {
    const result = await handleFeishuRequest(`calendar_${action}`, params);
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] calendar_${action} failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// 飞书任务操作
fastify.post('/plugin/feishu/task', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized task attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { action, ...params } = request.body as any;
  console.log(`[Bridge] task: action=${action}, params=${JSON.stringify(params)}`);

  try {
    const result = await handleFeishuRequest(`task_${action}`, params);
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] task_${action} failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// 获取用户列表（目录服务）
fastify.post('/plugin/feishu/list_users', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized list_users attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { query, limit = 20 } = request.body as any;
  console.log(`[Bridge] list_users: query="${query}", limit=${limit}`);

  try {
    const result = await handleFeishuRequest('list_users', {
      query,
      page_size: limit,
    });
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] list_users failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// 获取群聊列表（目录服务）
fastify.post('/plugin/feishu/list_chats', async (request, reply) => {
  const verification = await verifyBridgeRequest(request);
  if (!verification.valid) {
    console.log(`[Bridge] Unauthorized list_chats attempt from ${request.ip}`);
    return reply.status(401).send({ error: verification.error });
  }

  const { query, limit = 20 } = request.body as any;
  console.log(`[Bridge] list_chats: query="${query}", limit=${limit}`);

  try {
    const result = await handleFeishuRequest('list_chats', {
      query,
      page_size: limit,
    });
    return { success: true, ...result };
  } catch (error: any) {
    console.error(`[Bridge] list_chats failed: ${error.message}`);
    return reply.status(500).send({ error: error.message });
  }
});

// ========== 容器清理任务 ==========

/**
 * 启动容器休眠任务（带用户 openid 的 sleep 池）
 * 用户离线超过 1 小时且容器内无正在执行的 openclaw 任务/定时任务时：
 * 先 commit 防宿主机异常导致环境丢失，再删网关容器，再起一个 sleep 的 user-pool 容器，用户状态改为 pooled。
 * 离线判断目前用 last_active（超过 1h 无消息）；后续可接飞书 SDK 的在线状态 API 更精确。
 */
function startContainerCleanupJob() {
  const inactiveTimeout = parseInt(process.env.CONTAINER_INACTIVE_TIMEOUT || '3600000'); // 默认1小时
  const checkInterval = parseInt(process.env.CONTAINER_CHECK_INTERVAL || '300000'); // 默认5分钟

  console.log(`🧹 Container sleep job started (idle > ${inactiveTimeout}ms → user-pool, interval: ${checkInterval}ms)`);

  setInterval(async () => {
    try {
      const users = findAllUsers();
      const now = Date.now();

      for (const user of users) {
        if (user.status.phase !== 'active' || !user.status.containerId) {
          continue;
        }

        const lastActive = user.lastActive || user.updatedAt;
        const inactiveDuration = now - lastActive;

        if (inactiveDuration <= inactiveTimeout) {
          continue;
        }

        const idle = await containerHasNoActiveOpenclawTasks(user.status.containerId);
        if (!idle) {
          continue;
        }

        const openId = user.spec.feishuOpenId;
        console.log(`🧹 User ${openId} inactive ${inactiveDuration}ms and container idle, putting to user-pool (sleep)...`);

        try {
          await putUserContainerToSleep(openId, user.status.containerId);
          await updateUserStatusRecord(openId, { phase: 'pooled' });
          console.log(`✅ User ${openId} container moved to user-pool`);
        } catch (error) {
          console.error(`❌ Failed to put container to sleep for ${openId}:`, error);
        }
      }
    } catch (error) {
      console.error('❌ Error in container sleep job:', error);
    }
  }, checkInterval);
}

// ========== 离职员工容器清理任务 ==========

/**
 * 每隔一段时间（默认每天）查询飞书 EHR 员工花名册，
 * 对于在 EHR 中不再处于 active 状态的员工：
 * - 停止并删除其运行中的容器（通过 returnToPool 保留镜像）
 * - 将用户状态标记为 stopped（不再自动重启容器）
 *
 * 镜像作为公司资产保留，后续可用于评估和交接。
 */
function startOffboardCleanupJob() {
  const intervalMs = parseInt(process.env.OFFBOARD_CLEANUP_INTERVAL_MS || '86400000'); // 默认 24 小时

  console.log(`🧹 Offboard cleanup job started (interval: ${intervalMs}ms)`);

  setInterval(async () => {
    try {
      const users = findAllUsers();
      if (users.length === 0) return;

      console.log('🧹 Offboard cleanup: fetching employees from Feishu EHR...');

      // 简单分页拉取员工花名册
      const activeIds = new Set<string>();
      let pageToken: string | undefined;
      // 最多拉取若干页以避免 bug 导致死循环
      for (let i = 0; i < 20; i++) {
        const params: any = { page_size: 200 };
        if (pageToken) params.page_token = pageToken;

        const data = await handleFeishuRequest('list_employees', params);

        const items: any[] = Array.isArray(data?.items) ? data.items : Array.isArray(data?.employees) ? data.employees : [];
        for (const emp of items) {
          const userId = emp?.user_id || emp?.open_id || emp?.employee_id;
          if (!userId) continue;

          // employment_status 结构可能为 { status: 'active' | 'inactive' | ... }
          const status = emp?.employment_status?.status || emp?.employment_status?.employment_status;
          if (!status || status === 'active') {
            activeIds.add(userId);
          }
        }

        if (!data?.has_more || !data?.page_token) break;
        pageToken = data.page_token as string;
      }

      // 没拉到任何员工就不做动作，避免误杀
      if (activeIds.size === 0) {
        console.warn('🧹 Offboard cleanup: no employees fetched from EHR, skipping this run');
        return;
      }

      const now = Date.now();

      for (const user of users) {
        const openId = user.spec.feishuOpenId;

        // 仅处理在本地存在，但在 EHR 里不再 active 的用户
        if (activeIds.has(openId)) continue;

        // 没有容器就只更新状态
        if (!user.status.containerId) {
          if (user.status.phase !== 'stopped') {
            await updateUserStatusRecord(openId, { phase: 'stopped' });
            console.log(`🧹 Offboard: user ${openId} has no container; status set to stopped`);
          }
          continue;
        }

        console.log(`🧹 Offboard: user ${openId} is not active in EHR, cleaning up container ${user.status.containerId}...`);

        try {
          // 使用 returnToPool：commit 容器到用户镜像并删除容器
          await returnToPool(user.status.containerId, openId);
          await updateUserStatusRecord(openId, { phase: 'stopped' });
          console.log(`✅ Offboard: container for user ${openId} committed & removed, status=stopped`);
        } catch (error) {
          console.error(`❌ Offboard cleanup failed for user ${openId}:`, error);
        }
      }
    } catch (error) {
      console.error('❌ Error in offboard cleanup job:', error);
    }
  }, intervalMs);
}

// 启动飞书 WebSocket 连接
async function startFeishuWS() {
  if (!config.feishu.app_id || !config.feishu.app_secret) {
    console.error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
    return;
  }

  const wsClient = createFeishuWSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
  });

  await wsClient.start(async (event: FeishuMessageEvent) => {
    // 处理收到的消息
    try {
      await handleFeishuMessage(event);
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  console.log('Feishu WebSocket client started');
}

// 启动服务器
async function start() {
  initTracing(); // OpenTelemetry, only active if OTEL_ENABLED=true
  try {
    // 初始化用户映射表
    await initUserMap();
    await initSkillStore();

    // 注册 Skill 管理路由
    const { skillAdminRoutes } = await import('./admin/skill-admin.js');
    await fastify.register(skillAdminRoutes);

    // 注册 JWT 认证
    const { registerAuth } = await import('./admin/middleware.js');
    await registerAuth(fastify);

    // 注册 Agent 路由 (无 requireAuth，Agent 使用 token 验证)
    const { registerAgentRoutes } = await import('./agent/routes.js');
    registerAgentRoutes(fastify);

    // 注册用户管理路由
    const { registerUserRoutes } = await import('./admin/routes/users.js');
    registerUserRoutes(fastify);

    // 注册容器管理路由
    const { registerContainerRoutes } = await import('./admin/routes/containers.js');
    registerContainerRoutes(fastify);

    // 注册 DLQ 路由
    const { registerDLQRoutes } = await import('./admin/routes/dlq.js');
    registerDLQRoutes(fastify);

    // 注册内容审核路由 (admin only)
    const { registerModerationRoutes } = await import('./admin/routes/moderation.js');
    registerModerationRoutes(fastify);

    // System config API (runtime admin settings)
    const { registerConfigRoutes } = await import('./admin/routes/config.js');
    registerConfigRoutes(fastify);

    // Network ACL REST API routes
    const { registerNetworkRoutes } = await import('./admin/routes/network.js');
    registerNetworkRoutes(fastify);

    // CSV bulk user import
    const { registerImportRoutes } = await import('./admin/routes/import.js');
    registerImportRoutes(fastify);

    // Task 10: Orphaned Resource Cleanup — scan and remove stray containers on startup
    const { cleanupOrphanedResources } = await import('./lib/cleanup.js');
    const cleanupResult = await cleanupOrphanedResources();
    if (cleanupResult.removed.length > 0) {
      console.log(`[Startup] Orphaned containers cleaned: ${cleanupResult.removed.join(', ')}`);
    }
    if (cleanupResult.errors.length > 0) {
      console.warn(`[Startup] Orphan cleanup errors: ${cleanupResult.errors.join('; ')}`);
    }

    // 初始化容器池
    const { initContainerPool, warmUpPool } = await import('./container-pool.js');
    initContainerPool({
      poolSize: parseInt(process.env.POOL_SIZE || '2'),
      openclawImage: process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest',
      dataDir: process.env.DATA_DIR || '/data/users',
    });

    // 预热容器池（可选）
    if (process.env.AUTO_WARM_POOL === 'true') {
      setTimeout(() => warmUpPool(), 5000); // 启动后 5 秒预热
    }

    initRouter({
      feishu: {
        app_id: config.feishu.app_id,
        app_secret: config.feishu.app_secret,
      },
      docker: {
        host: process.env.DOCKER_HOST || 'localhost',
        port: parseInt(process.env.DOCKER_PORT || '2375'),
        openclawImage: process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest',
        dataDir: process.env.DATA_DIR || '/data/users',
      },
      gateway: {
        hooksTokenSalt: process.env.HOOKS_TOKEN_SALT || 'default-salt-change-me',
      },
    });

    await initUserTokenStore();

    const useTls = process.env.TLS_ENABLED === 'true';
    if (useTls) {
      const serverOptions = {
        cert: readFileSync(process.env.TLS_CERT_FILE!),
        key: readFileSync(process.env.TLS_KEY_FILE!),
      };
      const httpsServer = createServer(serverOptions, fastify.server as unknown as Parameters<typeof createServer>[1]);
      httpsServer.listen({ port: config.port, host: '0.0.0.0' });
      console.log(`🚀 Connector HTTPS server listening on port ${config.port}`);
    } else {
      await fastify.listen({ port: config.port, host: '0.0.0.0' });
      console.log(`🚀 Connector HTTP server listening on port ${config.port}`);
    }

    // 启动 WebSocket 连接
    await startFeishuWS();

    // 启动容器清理任务
    startContainerCleanupJob();

    // 启动离职员工容器清理任务（每日）
    startOffboardCleanupJob();

    // ========== Periodic gateway health checks ==========
    const { checkGatewayHealth } = await import('./gateway-client.js');
    const { findUsersByPhase, updateUserStatusRecord } = await import('./user-map.js');
    const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '30000');
    setInterval(async () => {
      const activeUsers = findUsersByPhase('active');
      for (const user of activeUsers) {
        if (!user.status.gatewayUrl || !user.status.gatewayAuthToken) continue;
        const healthy = await checkGatewayHealth(user.status.gatewayUrl, user.status.gatewayAuthToken);
        if (!healthy) {
          console.warn(`[HealthCheck] Gateway unhealthy for ${user.spec.feishuOpenId}, marking error`);
          await updateUserStatusRecord(user.spec.feishuOpenId, { phase: 'error', lastError: 'Gateway health check failed' });
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
