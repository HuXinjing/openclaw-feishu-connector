/**
 * ChannelOutboundAdapter implementation
 * Receives replies from OpenClaw Core and delivers them via the Connector
 */
import type { ChannelOutboundAdapter } from 'openclaw/plugin-sdk/channel-send-result';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';

// Minimal ReplyPayload shape for our adapter needs
interface ReplyPayload {
  text?: string;
  interactive?: Record<string, unknown>;
  mediaUrl?: string;
  mediaUrls?: string[];
}

interface SendContext {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  replyToId?: string;
  threadId?: string | number;
}

export function createOutboundAdapter(
  connectorBaseUrl: string,
  connectorToken: string,
  feishuOpenId?: string
): ChannelOutboundAdapter {
  async function callConnector(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = action.includes('/')
      ? `${connectorBaseUrl}${action}`
      : `${connectorBaseUrl}/plugin/feishu/${action}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${connectorToken}`,
    };
    if (feishuOpenId) headers['X-User-OpenId'] = feishuOpenId;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return response.json();
  }

  function buildContent(payload: ReplyPayload): string {
    if (payload.interactive) {
      return JSON.stringify(payload.interactive);
    }
    return payload.text ?? '';
  }

  return {
    deliveryMode: 'direct',

    async sendPayload(ctx) {
      const payload = (ctx as unknown as { payload: ReplyPayload }).payload;
      const { to } = ctx;
      const content = buildContent(payload);
      const msg_type = payload.interactive ? 'interactive' : 'text';
      await callConnector('send', {
        receive_id: to,
        receive_id_type: 'open_id',
        content,
        msg_type,
      });
      return { channel: 'feishu-bridge', messageId: crypto.randomUUID() };
    },

    async sendText(ctx) {
      const { to, text } = ctx as unknown as { to: string; text: string };
      await callConnector('send', {
        receive_id: to,
        receive_id_type: 'open_id',
        content: text,
        msg_type: 'text',
      });
      return { channel: 'feishu-bridge', messageId: crypto.randomUUID() };
    },
  };
}
