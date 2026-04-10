/**
 * 飞书 API 客户端
 */
import axios from 'axios';
import type { FeishuSendMessageRequest } from './types.js';

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  tenantAccessToken?: string;
  tenantTokenExpireTime?: number;
}

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

/**
 * 创建飞书客户端
 */
export function createFeishuClient(config: FeishuClientConfig) {
  let tenantToken = config.tenantAccessToken;
  let tokenExpireTime = config.tenantTokenExpireTime || 0;

  const client = axios.create({
    baseURL: FEISHU_API_BASE,
    timeout: 30000,
  });

  // 添加 token 到请求头
  client.interceptors.request.use((conf) => {
    if (tenantToken && Date.now() < tokenExpireTime) {
      conf.headers.Authorization = `Bearer ${tenantToken}`;
    }
    return conf;
  });

  /**
   * 获取 tenant_access_token
   */
  async function getTenantAccessToken(): Promise<string> {
    // 如果当前 token 有效，直接返回
    if (tenantToken && Date.now() < tokenExpireTime - 60000) {
      return tenantToken;
    }

    try {
      const response = await client.post<{
        code: number;
        msg: string;
        tenant_access_token: string;
        expire: number;
      }>('/auth/v3/tenant_access_token/internal', {
        app_id: config.appId,
        app_secret: config.appSecret,
      });

      if (response.data.code !== 0) {
        throw new Error(`Failed to get tenant token: ${response.data.msg}`);
      }

      tenantToken = response.data.tenant_access_token;
      tokenExpireTime = Date.now() + response.data.expire * 1000;

      return tenantToken;
    } catch (err) {
      // Graceful degradation: if Feishu API is unavailable, return cached token if still valid
      console.warn(`[Feishu] API unavailable, using cached token: ${err instanceof Error ? err.message : String(err)}`);
      if (tenantToken && tokenExpireTime > Date.now()) {
        return tenantToken;
      }
      throw err;
    }
  }

  /**
   * 发送消息
   */
  async function sendMessage(
    receiveId: string,
    receiveIdType: 'open_id' | 'user_id' | 'chat_id',
    messageType: 'text' | 'post' | 'image',
    content: unknown
  ): Promise<string> {
    await getTenantAccessToken();

    const request: FeishuSendMessageRequest = {
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: messageType,
      content: JSON.stringify(content),
    };

    const response = await client.post<{
      code: number;
      msg: string;
      data?: { message_id: string };
    }>('/im/v1/messages', request, {
      params: { receive_id_type: receiveIdType },
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to send message: ${response.data.msg}`);
    }

    return response.data.data?.message_id || '';
  }

  /**
   * 发送文本消息
   */
  async function sendText(receiveId: string, receiveIdType: 'open_id' | 'user_id' | 'chat_id', text: string): Promise<string> {
    return sendMessage(receiveId, receiveIdType, 'text', { text });
  }

  /**
   * 发送富文本消息 (post)
   */
  async function sendPost(
    receiveId: string,
    receiveIdType: 'open_id' | 'user_id' | 'chat_id',
    post: {
      zh_cn?: {
        title?: string;
        content: unknown[][];
      };
    }
  ): Promise<string> {
    return sendMessage(receiveId, receiveIdType, 'post', post);
  }

  /**
   * 回复消息
   */
  async function replyMessage(messageId: string, messageType: 'text' | 'post', content: unknown): Promise<string> {
    await getTenantAccessToken();

    const request = {
      msg_type: messageType,
      content: JSON.stringify(content),
    };

    const response = await client.post<{
      code: number;
      msg: string;
      data?: { message_id: string };
    }>(`/im/v1/messages/${messageId}/reply`, request);

    if (response.data.code !== 0) {
      throw new Error(`Failed to reply message: ${response.data.msg}`);
    }

    return response.data.data?.message_id || '';
  }

  /**
   * 上传图片
   */
  async function uploadImage(imageType: 'message' | 'avatar', image: Buffer, imageName: string): Promise<string> {
    await getTenantAccessToken();

    const formData = new FormData();
    formData.append('image_type', imageType);
    formData.append('image', new Blob([image.buffer as ArrayBuffer]), imageName);

    const response = await client.post<{
      code: number;
      msg: string;
      data?: { image_key: string };
    }>('/im/v1/images', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to upload image: ${response.data.msg}`);
    }

    return response.data.data?.image_key || '';
  }

  /**
   * 发送图片消息
   */
  async function sendImage(receiveId: string, receiveIdType: 'open_id' | 'user_id' | 'chat_id', imageKey: string): Promise<string> {
    return sendMessage(receiveId, receiveIdType, 'image', { image_key: imageKey });
  }

  return {
    getTenantAccessToken,
    sendMessage,
    sendText,
    sendPost,
    replyMessage,
    uploadImage,
    sendImage,
  };
}

/**
 * 便捷函数：快速发送文本消息
 */
export async function sendFeishuText(
  appId: string,
  appSecret: string,
  receiveId: string,
  receiveIdType: 'open_id' | 'user_id' | 'chat_id',
  text: string
): Promise<string> {
  const client = createFeishuClient({ appId, appSecret });
  return client.sendText(receiveId, receiveIdType, text);
}

// ========== Typing Indicator (敲键盘表情) ==========

export interface TypingState {
  messageId: string;
  reactionId: string | null;
}

/**
 * 添加敲键盘表情 (typing indicator)
 * 使用飞书消息Reaction API添加"输入中"表情
 * 参考 openclaw-lark 官方插件实现
 */
export async function addTypingIndicator(
  appId: string,
  appSecret: string,
  messageId: string
): Promise<TypingState> {
  const client = createFeishuClient({ appId, appSecret });
  const token = await client.getTenantAccessToken();

  try {
    // 使用 message_reactions API 添加敲键盘表情 (英文 "Typing")
    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/messages/${messageId}/reactions`,
      {
        reaction_type: {
          emoji_type: "Typing",  // 必须用英文 "Typing"
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.code !== 0) {
      console.warn('Failed to add typing indicator:', response.data);
      return { messageId, reactionId: null };
    }

    return {
      messageId,
      reactionId: response.data.data?.reaction_id || null,
    };
  } catch (error) {
    console.warn('Error adding typing indicator:', error);
    return { messageId, reactionId: null };
  }
}

/**
 * 移除敲键盘表情
 * 参考 openclaw-lark 官方插件实现
 */
export async function removeTypingIndicator(
  appId: string,
  appSecret: string,
  state: TypingState
): Promise<void> {
  if (!state.reactionId) return;

  const client = createFeishuClient({ appId, appSecret });
  const token = await client.getTenantAccessToken();

  try {
    // 使用 delete message_reaction API (path 参数)
    await axios.delete(
      `${FEISHU_API_BASE}/im/v1/messages/${state.messageId}/reactions/${state.reactionId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      }
    );
  } catch (error) {
    console.warn('Error removing typing indicator:', error);
  }
}
