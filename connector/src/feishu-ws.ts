/**
 * 飞书 WebSocket 客户端模块 - 使用官方 SDK
 */
import Lark from '@larksuiteoapi/node-sdk';
import type { FeishuMessageEvent } from './types.js';

export interface WebSocketConfig {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  encryptKey?: string;
  verificationToken?: string;
}

/**
 * 创建飞书 WebSocket 客户端
 */
export function createFeishuWSClient(config: WebSocketConfig) {
  const { appId, appSecret, domain = 'feishu', encryptKey, verificationToken } = config;

  const client = new Lark.WSClient({
    appId,
    appSecret,
    domain: domain === 'feishu' ? Lark.Domain.Feishu : Lark.Domain.Lark,
    loggerLevel: Lark.LoggerLevel.debug,
  });

  // 创建事件分发器，用于解密消息并分发事件
  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: encryptKey || '',
    verificationToken: verificationToken || '',
  });

  let messageHandler: ((event: FeishuMessageEvent) => void) | null = null;
  let stopCallback: (() => void) | null = null;

  /**
   * 启动 WebSocket 连接
   */
  // 消息去重：记录已处理的消息ID
  const processedMessages = new Set<string>();

  async function start(onMessage: (event: FeishuMessageEvent) => void): Promise<void> {
    messageHandler = onMessage;

    // 注册事件处理
    eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        console.log('📩 收到消息事件:', JSON.stringify(data, null, 2));
        if (messageHandler) {
          const event = data as unknown as FeishuMessageEvent;
          const messageId = event.message?.message_id;

          // 去重检查
          if (messageId && processedMessages.has(messageId)) {
            console.log('⏭️ 消息已处理过，跳过:', messageId);
            return;
          }

          // 标记消息为已处理
          if (messageId) {
            processedMessages.add(messageId);
            // 5分钟后清理，避免内存泄漏
            setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);
          }

          // 使用 await 确保处理完成
          await messageHandler(event);
          console.log('✅ 消息处理完成');
        }
      },
      'im.message.message_read_v1': async () => {
        // 忽略已读回执
      },
    });

    return new Promise((resolve, reject) => {
      // 启动 WebSocket 客户端，传入 eventDispatcher
      // 注意：client.start() 返回 void，stop 需要通过其他方式获取
      client.start({
        eventDispatcher,
      }).then(() => {
        // WebSocket 已启动
        resolve();
      }).catch(reject);
    });
  }

  /**
   * 停止连接
   */
  function stop(): void {
    if (stopCallback) {
      stopCallback();
      stopCallback = null;
    }
    messageHandler = null;
  }

  return {
    start,
    stop,
  };
}
