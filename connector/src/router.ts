/**
 * 用户路由逻辑 - 将消息路由到对应用户的 Gateway
 * 支持自动创建用户和容器
 *
 * Tasks 3-5:
 * - Task 3: Stale object refresh before updateUserStatus after await
 * - Task 4: Message deduplication cache
 * - Task 5: Per-chat promise-chain queue
 *
 * Task 4 (ClawManager): Reverse heartbeat — messages are now enqueued for Gateway Agent
 * to poll via /agent/heartbeat instead of Connector pushing to Gateway.
 * The push path (sendToGateway) is preserved for backwards compatibility but the
 * queue-based pull path is the new preferred route.
 */
import type { FeishuUserRecord, FeishuMessageEvent } from './types.js';
import { findUserByOpenId, updateUserLastActive, createUser, generateGatewayToken, updateUserStatus, updateUserStatusRecord, getNextGatewayPort, getUserPort } from './user-map.js';
import { createGatewayClient, sendToGateway, sendToGatewayViaHooks } from './gateway-client.js';
import { sendFeishuText, addTypingIndicator, removeTypingIndicator } from './feishu-client.js';
import { initDocker, createUserContainer, createUserContainerFromImage, startUserContainer, getUserGatewayUrl, getGatewayAuthToken, commitContainerToImage, removeContainer, userImageExists, containerExists } from './docker.js';
import { acquireFromPool, userImageExists as checkUserImageExists } from './container-pool.js';
import { enqueueDLQ } from './lib/dlq.js';
import { enqueueUserMessage } from './agent/message-queue.js';
import { storeAgentMessage } from './agent/routes.js';
import { getThreadId } from './types.js';
import { checkIdempotency, setIdempotency, buildMessageIdempotencyKey } from './lib/idempotency.js';
import { moderateMessage } from './lib/moderation.js';

// ========== Task 12: Session Key Builder ==========
/**
 * Build a session key for routing.
 * Includes threadId for thread-scoped sessions, falls back to DM key.
 */
function buildSessionKey(openId: string, event: FeishuMessageEvent): string {
  const threadId = getThreadId(event);
  return threadId ? `${openId}:thread:${threadId}` : `dm:${openId}`;
}

// ========== Task 4: Message Dedup Cache ==========
// Filters duplicate event deliveries from Feishu WS reconnect replays.
// Uses in-memory TTL cache to avoid unbounded growth.
class MessageDedup {
  private cache = new Map<string, number>();
  private maxEntries = 1000;
  private ttlMs = 60_000; // 1 minute TTL

  tryRecord(eventId: string): boolean {
    if (!eventId) return true; // no eventId, allow through
    const now = Date.now();
    const expiry = now - this.ttlMs;

    // Lazy cleanup on 10% of calls
    if (this.cache.size > this.maxEntries * 0.9) {
      for (const [key, ts] of this.cache) {
        if (ts < expiry) this.cache.delete(key);
      }
    }

    if (this.cache.has(eventId)) {
      return false; // duplicate
    }
    this.cache.set(eventId, now);
    return true;
  }
}

const messageDedup = new MessageDedup();

// ========== Task 5: Per-Chat Promise-Chain Queue ==========
interface MessageQueueBuffer {
  messages: string[];
  event: FeishuMessageEvent;
  processingPromise: Promise<void>;
  resolveProcessing: () => void;
  startedAt: number;
}

const messageQueueBuffers = new Map<string, MessageQueueBuffer>();

async function processMessageQueueForUser(openId: string): Promise<void> {
  const q = messageQueueBuffers.get(openId);
  if (!q) return;

  // Fix 4: timeout check — if queue has been waiting too long, notify and abort
  const maxWaitMs = 600_000; // 10 minutes max wait (container can take several minutes to start)
  if (q.startedAt && Date.now() - q.startedAt > maxWaitMs) {
    console.log(`[Queue] Queue timeout for ${openId}, notifying...`);
    messageQueueBuffers.delete(openId);
    q.resolveProcessing();
    try {
      await sendFeishuText(config.feishu.app_id, config.feishu.app_secret, openId, 'open_id', '抱歉，服务启动超时，请稍后再试。');
    } catch {}
    return;
  }

  // Buffer for 2s to coalesce rapid messages
  await new Promise(r => setTimeout(r, 2000));

  const freshUser = findUserByOpenId(openId);
  // Fix 2: if user not yet active after buffer wait, retry with timeout
  if (!freshUser || freshUser.status.phase !== 'active') {
    console.log(`[Queue] User ${openId} not yet active (phase=${freshUser?.status.phase || 'unknown'}), keeping queue...`);
    // Re-queue: append to buffer and re-trigger container wait
    messageQueueBuffers.delete(openId);
    q.resolveProcessing();

    // Re-enqueue by calling createUserContainerAsync again with a delay
    setTimeout(() => {
      const retryUser = findUserByOpenId(openId);
      if (retryUser && retryUser.status.phase === 'active') {
        // Ready now, process queue
        processMessageQueueForUser(openId);
      } else {
        // Still not ready, send notification
        try {
          sendFeishuText(config.feishu.app_id, config.feishu.app_secret, openId, 'open_id',
            '抱歉，容器启动需要更长时间，请稍后再发消息。');
        } catch {}
      }
    }, 10_000); // 10s retry
    return;
  }

  const combined = q.messages.join('\n\n---\n\n');
  console.log(`[Queue] Processing ${q.messages.length} messages for ${openId}`);

  // Note: typing indicator is already set by handleFeishuMessage before enqueuing — do not re-set here.
  const sessionKey = buildSessionKey(openId, q.event);
  console.log(`[Session] Queue processing with key: ${sessionKey}`);
  try {
    const response = await sendToGateway(freshUser.status.gatewayUrl!, freshUser.status.gatewayAuthToken!, combined);
    if (response.ok && response.text) {
      await sendFeishuText(config.feishu.app_id, config.feishu.app_secret, openId, 'open_id', response.text);
    } else {
      await sendFeishuText(config.feishu.app_id, config.feishu.app_secret, openId, 'open_id', `抱歉，服务出现错误：${response.error}`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    await sendFeishuText(config.feishu.app_id, config.feishu.app_secret, openId, 'open_id', `抱歉，连接服务失败：${errMsg}`);
    enqueueDLQ(q.event.message?.message_id || String(Date.now()), openId, combined, errMsg);
  }

  messageQueueBuffers.delete(openId);
  q.resolveProcessing();
}

/** Flush (resolve) a user's queue after processing. */
function flushQueue(openId: string): void {
  const q = messageQueueBuffers.get(openId);
  if (!q) return;
  messageQueueBuffers.delete(openId);
  q.resolveProcessing();
}

// ========== Gateway token wait helper ==========
/**
 * Wait for Gateway auth token with exponential backoff.
 * Retries every baseInterval * 1.5^attempt seconds, capped at 30s intervals.
 * Maximum total wait time: maxWaitMs (default 5 minutes).
 */
export async function waitForGatewayAuthToken(containerId: string, maxWaitMs = 300_000): Promise<string> {
  const baseIntervalMs = 3000;
  let attempt = 0;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const token = await getGatewayAuthToken(containerId);
      if (token && token.trim()) {
        if (attempt > 0) {
          console.log(`[Retry] Gateway auth token received after ${attempt} retries`);
        }
        return token;
      }
    } catch {
      // Not ready, continue waiting
    }
    const interval = Math.min(baseIntervalMs * Math.pow(1.5, attempt), 30_000);
    await new Promise(r => setTimeout(r, interval));
    attempt++;
  }
  throw new Error('Gateway auth token not ready in time');
}

export interface RouterConfig {
  feishu: {
    app_id: string;
    app_secret: string;
  };
  docker: {
    host: string;
    port: number;
    openclawImage: string;
    dataDir: string;
  };
  gateway: {
    hooksTokenSalt: string;
  };
}

/**
 * 路由配置
 */
let config: RouterConfig;
let dockerInitialized = false;

/**
 * 初始化路由器
 */
export function initRouter(cfg: RouterConfig): void {
  config = cfg;

  // 初始化 Docker
  if (!dockerInitialized) {
    initDocker({
      host: cfg.docker.host,
      port: cfg.docker.port,
      openclawImage: cfg.docker.openclawImage,
      dataDir: cfg.docker.dataDir,
      gatewayBasePort: 18790,
    });
    dockerInitialized = true;
  }
}

/**
 * 路由结果
 */
export interface RouteResult {
  handled: boolean;
  error?: string;
}

/**
 * 处理收到的飞书消息
 */
export async function handleFeishuMessage(event: FeishuMessageEvent): Promise<RouteResult> {
  // ========== Task 4: Dedup — MUST be the very first thing ==========
  const eventId = event.message?.message_id;
  if (!messageDedup.tryRecord(eventId)) {
    console.log(`[Dedup] Skipping duplicate event: ${eventId}`);
    return { handled: true };
  }

  // ========== Task 7: Idempotency Key ==========
  const senderOpenId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id;
  if (!senderOpenId) {
    return { handled: false, error: 'No sender open_id found' };
  }
  if (eventId) {
    const ik = buildMessageIdempotencyKey(senderOpenId, eventId);
    const cached = checkIdempotency(ik);
    if (cached) {
      console.log(`[Idempotency] Duplicate request ${ik}, returning cached response`);
      return cached.response as RouteResult;
    }
  }

  // 立即显示敲键盘状态，让用户知道消息已收到
  let typingState = null;
  try {
    const messageId = event.message?.message_id;
    if (messageId) {
      typingState = await addTypingIndicator(config.feishu.app_id, config.feishu.app_secret, messageId);
      console.log(`⌨️ Typing indicator shown for message ${messageId}`);
    }
  } catch (e) {
    console.warn('Failed to add typing indicator:', e);
  }

  // 提取消息内容
  let messageText = '';
  try {
    const content = JSON.parse(event.message.content);
    messageText = content.text?.trim() || '';
  } catch {
    if (typingState) {
      try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {}
    }
    return { handled: false, error: 'Failed to parse message content' };
  }

  if (!messageText) {
    if (typingState) {
      try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {}
    }
    return { handled: false, error: 'Empty message' };
  }

  // Task 8: Content Moderation — check message against rule engine
  const mod = moderateMessage(messageText);
  if (!mod.allowed) {
    console.warn(`[Moderation] Message blocked for ${senderOpenId}:`, mod.hits.map(h => h.rule.id));
    if (typingState) {
      try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {}
    }
    await sendFeishuText(
      config.feishu.app_id,
      config.feishu.app_secret,
      senderOpenId,
      'open_id',
      '抱歉，您的消息因内容审核未通过无法处理。'
    );
    return { handled: true };
  }
  if (mod.hits.length > 0) {
    console.warn(`[Moderation] Message flagged for ${senderOpenId}:`, mod.hits.map(h => h.rule.id));
    // TODO: logAudit('message.flagged', senderOpenId, eventId, { hits: mod.hits });
  }

  // 查找用户
  let user = findUserByOpenId(senderOpenId);
  console.log(`🔍 查找用户: ${senderOpenId}, 结果:`, user ? '找到' : '未找到');

  // 用户不存在？创建用户并走队列，与「已有用户但 pending」统一为单次容器创建
  if (!user) {
    console.log(`👤 New user detected: ${senderOpenId}, creating user and queue...`);

    // 立即回复用户，告知正在启动
    await sendFeishuText(
      config.feishu.app_id,
      config.feishu.app_secret,
      senderOpenId,
      'open_id',
      '🦐 稍等亲，正在启动你的专属有虾...'
    );

    // 创建用户（pending）
    const hooksTokenSalt = config.gateway.hooksTokenSalt;
    const gatewayToken = generateGatewayToken(senderOpenId, hooksTokenSalt);
    const port = getNextGatewayPort();
    const gatewayUrl = getUserGatewayUrl(senderOpenId, port);
    user = await createUser(senderOpenId, gatewayUrl, gatewayToken, undefined, port);

    // Task 5: Promise-chain queue — start async container creation + queue
    let resolveProcessing!: () => void;
    const processingPromise = new Promise<void>(r => { resolveProcessing = r; });
    messageQueueBuffers.set(senderOpenId, {
      messages: [messageText],
      event,
      processingPromise,
      resolveProcessing,
      startedAt: Date.now(),
    });
    console.log(`[Queue] New queue for ${senderOpenId}, starting container...`);

    createUserContainerAsync(senderOpenId, user, event).then(() => {
      processMessageQueueForUser(senderOpenId);
    }).catch((err) => {
      console.error(`[Queue] createUserContainerAsync failed for ${senderOpenId}:`, err);
      flushQueue(senderOpenId);
    });

    return { handled: true };
  }

  // 检查用户状态
  if (user.status.phase !== 'active') {
    // Task 5: Promise-chain queue — serialize concurrent messages for this user.
    const existingQueue = messageQueueBuffers.get(senderOpenId);
    if (existingQueue) {
      existingQueue.messages.push(messageText);
      console.log(`[Queue] Appended to existing queue for ${senderOpenId}, length: ${existingQueue.messages.length}`);
      return { handled: true };
    }

    // First message for non-active user — create queue and start container
    let resolveProcessing!: () => void;
    const processingPromise = new Promise<void>(r => { resolveProcessing = r; });
    messageQueueBuffers.set(senderOpenId, {
      messages: [messageText],
      event,
      processingPromise,
      resolveProcessing,
      startedAt: Date.now(),
    });
    console.log(`[Queue] New queue for ${senderOpenId}, starting container...`);

    // Trigger container creation asynchronously
    createUserContainerAsync(senderOpenId, user, event).then(() => {
      processMessageQueueForUser(senderOpenId);
    }).catch((err) => {
      console.error(`[Queue] createUserContainerAsync failed for ${senderOpenId}:`, err);
      flushQueue(senderOpenId);
    });

    return { handled: true };
  }

  // 更新最后活跃时间
  await updateUserLastActive(senderOpenId);

  // 检查 Gateway 是否可达，如果不可达则重建容器
  try {
    const freshCheck = findUserByOpenId(senderOpenId);
    if (!freshCheck) {
      if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
      return { handled: false, error: 'User disappeared during gateway check' };
    }

    const gatewayClient = createGatewayClient(freshCheck.status.gatewayUrl!, freshCheck.status.gatewayAuthToken!);
    const gatewayStatus = await gatewayClient.getStatus();
    if (!gatewayStatus.ok) {
      console.log(`⚠️ Gateway 不可用 (${gatewayStatus.error})，正在重建容器...`);
      // === Task 3: Stale object refresh ===
      const freshUser = findUserByOpenId(senderOpenId);
      if (!freshUser) {
        console.log(`[StaleRefresh] User ${senderOpenId} disappeared during gateway check`);
        if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
        return { handled: false, error: 'User disappeared during gateway check' };
      }
      user = freshUser;
      await updateUserStatusRecord(senderOpenId, { phase: 'pending' });
      user.status.phase = 'pending';
    } else {
      user = freshCheck;
    }
  } catch (e) {
    console.log(`⚠️ Gateway 连接失败，正在重建容器...`);
    // === Task 3: Stale object refresh ===
    const freshUser2 = findUserByOpenId(senderOpenId);
    if (!freshUser2) {
      console.log(`[StaleRefresh] User ${senderOpenId} disappeared during gateway check`);
      if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
      return { handled: false, error: 'User disappeared during gateway check' };
    }
    user = freshUser2;
    await updateUserStatusRecord(senderOpenId, { phase: 'pending' });
    user.status.phase = 'pending';
  }

  // 如果用户状态不是 active，重新创建容器
  if (user.status.phase !== 'active') {
    console.log(`🔄 正在为用户 ${senderOpenId} 创建新容器...`);

    try {
      const hooksTokenSalt = config.gateway.hooksTokenSalt;
      const gatewayToken = generateGatewayToken(senderOpenId, hooksTokenSalt);

      // 尝试复用原有端口
      let port: number;
      const existingPort = getUserPort(senderOpenId);
      if (existingPort) {
        port = existingPort;
        console.log(`📍 复用原有端口: ${port}`);
      } else {
        port = getNextGatewayPort();
      }

      // 检查并删除已存在的旧容器
      const containerName = `openclaw-gateway-${senderOpenId}`;
      const oldContainerExists = await containerExists(containerName);
      if (oldContainerExists) {
        console.log(`🗑️ 删除旧容器: ${containerName}`);
        await removeContainer(containerName);
      }

      // 使用容器池获取容器
      const containerId = await acquireFromPool(user, gatewayToken, port);

      // Gateway 启动后会写入 token，轮询等待
      const actualAuthToken = await waitForGatewayAuthToken(containerId);

      const newGatewayUrl = getUserGatewayUrl(senderOpenId, port);

      // === Task 3: Stale object refresh ===
      // Re-read user record before writing status after async op,
      // in case another event updated it while we were waiting.
      const freshRecreate = findUserByOpenId(senderOpenId);
      if (!freshRecreate) {
        console.log(`[StaleRefresh] User ${senderOpenId} disappeared during container recreation`);
        if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
        return { handled: false, error: 'User disappeared during container recreation' };
      }

      await updateUserStatusRecord(senderOpenId, {
        phase: 'active',
        containerId,
        gatewayAuthToken: actualAuthToken,
        gatewayUrl: newGatewayUrl,
        port,
      });

      user.status.phase = 'active';
      user.status.containerId = containerId;
      user.status.gatewayUrl = newGatewayUrl;
      user.status.gatewayAuthToken = actualAuthToken;
      user.status.port = port;

      console.log(`✅ 容器重建完成: ${containerId}, URL: ${newGatewayUrl}`);
    } catch (error) {
      console.error(`❌ 重建容器失败:`, error);
      if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
      await sendFeishuText(
        config.feishu.app_id,
        config.feishu.app_secret,
        senderOpenId,
        'open_id',
        '抱歉，服务正在重启中，请稍后再试...'
      );
      return { handled: true, error: 'Failed to recreate container' };
    }
  }

  // 发送到用户 Gateway
  try {
    const freshSend = findUserByOpenId(senderOpenId);

    // Task 4 (ClawManager): Enqueue for Gateway Agent pull.
    // Gateway Agent will poll /agent/heartbeat and fetch via /agent/messages/:eventId.
    const eventId = event.message?.message_id || String(Date.now());
    const sessionKey = buildSessionKey(senderOpenId, event);
    enqueueUserMessage(senderOpenId, {
      eventId,
      sessionKey,
      content: messageText,
      chatType: event.message.chat_type,
      threadId: getThreadId(event),
      enqueuedAt: Date.now(),
    });
    // Also store content for the /agent/messages/:eventId fetch
    storeAgentMessage(eventId, messageText);
    console.log(`[Queue] Enqueued message ${eventId} for user ${senderOpenId}, Gateway Agent will pick up on next heartbeat`);
    if (!freshSend) {
      if (typingState) { try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch {} }
      return { handled: false, error: 'User disappeared during send' };
    }
    user = freshSend;

    console.log(`📤 发送消息到 Gateway: ${user.status.gatewayUrl}, token: ${user.status.gatewayAuthToken?.substring(0, 8)}...`);
    console.log(`[Session] Key: ${sessionKey} for user ${senderOpenId}`);
    const response = await sendToGateway(
      user.status.gatewayUrl!,
      user.status.gatewayAuthToken!,
      messageText
    );

    if (!response.ok) {
      if (typingState) {
        try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch (e) { console.warn('Failed to remove typing indicator:', e); }
      }
      await sendFeishuText(
        config.feishu.app_id,
        config.feishu.app_secret,
        senderOpenId,
        'open_id',
        `抱歉，服务出现错误：${response.error}`
      );
      return { handled: true, error: response.error };
    }

    if (response.text) {
      console.log(`📥 Gateway 响应:`, response);
      console.log(`📤 发送响应到飞书: ${response.text.substring(0, 50)}...`);
      await sendFeishuText(
        config.feishu.app_id,
        config.feishu.app_secret,
        senderOpenId,
        'open_id',
        response.text
      );
    }

    if (typingState) {
      try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch (e) { console.warn('Failed to remove typing indicator:', e); }
    }

    // Task 7: Record successful response for idempotency
    if (eventId) {
      setIdempotency(buildMessageIdempotencyKey(senderOpenId, eventId), { handled: true });
    }

    return { handled: true };
  } catch (error) {
    if (typingState) {
      try { await removeTypingIndicator(config.feishu.app_id, config.feishu.app_secret, typingState); } catch (e) { console.warn('Failed to remove typing indicator:', e); }
    }

    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await sendFeishuText(
      config.feishu.app_id,
      config.feishu.app_secret,
      senderOpenId,
      'open_id',
      `抱歉，连接服务失败：${errorMsg}`
    );
    return { handled: true, error: errorMsg };
  }
}

// ========== 异步容器创建 ==========

/**
 * 异步创建用户容器 (Task 3: stale refresh at await points)
 */
async function createUserContainerAsync(
  senderOpenId: string,
  _user: FeishuUserRecord,
  event: FeishuMessageEvent
): Promise<void> {
  // Retry guard: if user has already failed 3 times, stop retrying
  const currentUser = findUserByOpenId(senderOpenId);
  const retryCount = currentUser?.status.retryCount ?? 0;
  if (retryCount >= 3) {
    await sendFeishuText(
      config.feishu.app_id,
      config.feishu.app_secret,
      senderOpenId,
      'open_id',
      '抱歉，服务启动多次失败，请联系管理员。'
    );
    await updateUserStatusRecord(senderOpenId, { phase: 'error', lastError: 'Max retries exceeded', retryCount });
    flushQueue(senderOpenId);
    return;
  }

  const hooksTokenSalt = config.gateway.hooksTokenSalt;
  const gatewayToken = generateGatewayToken(senderOpenId, hooksTokenSalt);

  // 尝试复用原有端口
  let port: number;
  const existingPort = getUserPort(senderOpenId);
  if (existingPort) {
    port = existingPort;
    console.log(`📍 复用原有端口: ${port}`);
  } else {
    port = getNextGatewayPort();
  }

  // 检查并删除已存在的旧容器
  const containerName = `openclaw-gateway-${senderOpenId}`;
  const oldContainerExists = await containerExists(containerName);
  if (oldContainerExists) {
    console.log(`🗑️ 删除旧容器: ${containerName}`);
    await removeContainer(containerName);
  }

  try {
    const gatewayUrl = getUserGatewayUrl(senderOpenId, port);

    // === Task 3: Stale object refresh — re-read before pool acquire ===
    const preAcquire = findUserByOpenId(senderOpenId);
    if (!preAcquire) {
      console.log(`[StaleRefresh] User ${senderOpenId} disappeared before container acquire`);
      return;
    }

    // 使用容器池获取容器
    const containerId = await acquireFromPool(preAcquire, gatewayToken, port);

    // Gateway 启动后会写入 token，轮询等待
    const actualAuthToken = await waitForGatewayAuthToken(containerId);

    console.log(`🔑 Gateway auth token: ${actualAuthToken}`);

    // === Task 3: Stale object refresh — re-read after waitForGatewayAuthToken ===
    const freshUser = findUserByOpenId(senderOpenId);
    if (!freshUser) {
      console.log(`[StaleRefresh] User ${senderOpenId} disappeared during container creation`);
      return;
    }

    await updateUserStatusRecord(senderOpenId, {
      phase: 'active',
      containerId,
      gatewayAuthToken: actualAuthToken,
      gatewayUrl,
      port,
      retryCount: 0,
    });

    console.log(`✅ Container ready for ${senderOpenId}: ${containerId}`);

    // Task 5: Container ready — the queued message processing is triggered by
    // the caller (handleFeishuMessage) via .then(() => processMessageQueueForUser(...))
  } catch (error) {
    console.error(`❌ Failed to create container:`, error);

    // Increment retry count on failure
    const userOnErr = findUserByOpenId(senderOpenId);
    if (userOnErr) {
      await updateUserStatusRecord(senderOpenId, {
        phase: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        retryCount: (userOnErr.status.retryCount || 0) + 1,
      });
    }

    // === Task 3: Stale object refresh — re-read before error notification ===
    const freshErr = findUserByOpenId(senderOpenId);
    if (!freshErr) {
      console.log(`[StaleRefresh] User ${senderOpenId} disappeared during error handling`);
      flushQueue(senderOpenId);
      return;
    }

    try {
      await sendFeishuText(
        config.feishu.app_id,
        config.feishu.app_secret,
        senderOpenId,
        'open_id',
        '🦐 抱歉，容器启动失败了，请稍后再试...'
      );
    } catch {}
    flushQueue(senderOpenId);
  }
}

/**
 * 获取用户 Gateway 客户端
 */
export function getUserGatewayClient(user: FeishuUserRecord) {
  return createGatewayClient(user.status.gatewayUrl!, user.status.gatewayAuthToken!);
}
