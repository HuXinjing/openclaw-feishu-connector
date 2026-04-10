/**
 * 飞书 Webhook 处理模块
 */
import { createHmac } from 'crypto';
import CryptoJS from 'crypto-js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { FeishuWebhookEvent, FeishuMessageEvent } from './types.js';

export interface WebhookConfig {
  encryptKey: string;
  verificationToken: string;
}

/**
 * 验证飞书 Webhook 签名
 */
export function verifyFeishuSignature(
  config: WebhookConfig,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string
): boolean {
  const signStr = timestamp + nonce + config.encryptKey + body;
  const expectedSignature = CryptoJS.SHA256(signStr).toString();
  return signature === expectedSignature;
}

/**
 * 验证 Verification Token (用于 Webhook URL 验证)
 */
export function verifyVerificationToken(config: WebhookConfig, token: string): boolean {
  return token === config.verificationToken;
}

/**
 * 解密飞书消息内容
 */
export function decryptContent(config: WebhookConfig, encrypt: string): string {
  const key = CryptoJS.enc.Utf8.parse(config.encryptKey);
  const iv = CryptoJS.enc.Utf8.parse(config.encryptKey.substring(0, 16));
  // @ts-ignore - CryptoJS types are incomplete
  const decrypted = CryptoJS.AES.decrypt(encrypt, key, { iv });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

/**
 * 解析 Webhook 请求体
 */
export function parseWebhookEvent(body: unknown, config: WebhookConfig): FeishuWebhookEvent | null {
  const event = body as FeishuWebhookEvent;
  if (!event?.header?.event_type) {
    return null;
  }
  return event;
}

/**
 * 检查是否为消息事件
 */
export function isMessageEvent(event: FeishuWebhookEvent): boolean {
  return event.header.event_type === 'im.message.receive_v1';
}

/**
 * 解析消息内容
 * 飞书消息内容是 JSON 字符串，需要根据消息类型解析
 */
export function parseMessageContent(messageType: string, content: string): unknown {
  try {
    const parsed = JSON.parse(content);
    if (messageType === 'text') {
      return parsed;
    }
    // 其他类型返回原始解析结果
    return parsed;
  } catch {
    return content;
  }
}

/**
 * 从消息事件中提取 sender open_id
 */
export function extractSenderOpenId(event: FeishuMessageEvent): string | null {
  const senderId = event.sender?.sender_id;
  return senderId?.open_id || senderId?.user_id || null;
}

/**
 * 从消息事件中提取消息文本内容
 */
export function extractMessageText(event: FeishuMessageEvent): string | null {
  if (event.message?.message_type === 'text') {
    try {
      const content = JSON.parse(event.message.content);
      return content?.text?.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 获取消息 ID
 */
export function getMessageId(event: FeishuMessageEvent): string | null {
  return event.message?.message_id || null;
}

/**
 * 获取聊天 ID
 */
export function getChatId(event: FeishuMessageEvent): string | null {
  return event.message?.chat_id || null;
}

/**
 * 获取聊天类型 (p2p 或 group)
 */
export function getChatType(event: FeishuMessageEvent): 'p2p' | 'group' | null {
  return event.message?.chat_type === 'p2p' ? 'p2p' : event.message?.chat_type === 'group' ? 'group' : null;
}

/**
 * 构建飞书 Webhook 响应 (用于验证 URL)
 */
export function buildChallengeResponse(challenge: string): object {
  return { challenge };
}

/**
 * HMAC-SHA256 webhook signature verification (per plan Task 2)
 */
function verifyWebhookSignature(
  body: string,
  timestamp: string,
  signature: string,
  encryptKey: string
): boolean {
  const str = timestamp + body;
  const expected = createHmac('sha256', encryptKey)
    .update(str)
    .digest('hex');
  return expected === signature;
}

/**
 * Create a Fastify webhook handler with signature verification and timestamp validation.
 * Call this from index.ts to register the /webhook endpoint.
 */
export function createWebhookHandler(options: {
  encryptKey: string;
  verificationToken: string;
  onMessage: (event: FeishuWebhookEvent) => Promise<void>;
}) {
  return async function handleWebhook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const rawBody = JSON.stringify(request.body);
    const timestamp = (request.headers['x-lark-timestamp'] as string) || '';
    const signature = (request.headers['x-lark-signature'] as string) || '';

    // Validate timestamp window (5-minute replay protection)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      return reply.status(400).send({ error: 'Timestamp expired' });
    }

    // Verify HMAC-SHA256 signature
    if (!verifyWebhookSignature(rawBody, timestamp, signature, options.encryptKey)) {
      return reply.status(403).send({ error: 'Invalid signature' });
    }

    const event = request.body as FeishuWebhookEvent;

    // Verify verification token (used for URL challenge)
    if (event.header?.token && event.header.token !== options.verificationToken) {
      return reply.status(403).send({ error: 'Invalid verification token' });
    }

    await options.onMessage(event);
    return reply.send({ code: 0 });
  };
}

/**
 * Dispatch Feishu events to appropriate handlers.
 * Called from the webhook endpoint after signature verification.
 */
export async function dispatchFeishuEvent(
  event: FeishuWebhookEvent,
  onMessage: (event: FeishuWebhookEvent) => Promise<void>
): Promise<void> {
  const eventType = event.header?.event_type || '';

  if (eventType.startsWith('im.message')) {
    const message = event.event?.message;
    if (message) {
      try {
        const content = JSON.parse(message.content);
        if (content.at_ids && Object.keys(content.at_ids).length > 0) {
          // @mention detected — delegate to mention handler
          const { handleMentionEvent } = await import('./events/mention.js');
          await handleMentionEvent(event);
          return;
        }
      } catch {
        // Non-text content, fall through to normal handler
      }
    }
    // Regular message
    await onMessage(event);
  } else if (eventType.startsWith('approval')) {
    const { handleApprovalEvent } = await import('./events/approval.js');
    await handleApprovalEvent(event);
  } else {
    console.log(`[Webhook] Received unhandled Feishu event type: ${eventType}`);
  }
}
