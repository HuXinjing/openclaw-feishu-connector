/**
 * neoway-feishu Bridge 插件
 *
 * 运行在 Gateway 容器内部，通过 HTTP 与外部 Connector 服务器通信
 * 统一管理飞书 IO 和业务 API 调用
 *
 * 使用方式：
 * 1. 编译：npm run build
 * 2. 安装到 Gateway：把 bridge-plugin 目录复制到 Gateway 容器
 * 3. 配置 openclaw.json：
 *    {
 *      "plugins": [{ "id": "neoway-feishu-bridge", "config": { "connectorBaseUrl": "http://host.docker.internal:3000", "connectorToken": "xxx" }}]
 *    }
 *
 * ClawManager Pattern: Gateway Agent polling
 *   AGENT_BOOTSTRAP_TOKEN — agt_boot_{openId}_{hooksToken}, triggers reverse heartbeat polling
 */

import type {
  OpenClawPluginApi,
  ChannelPlugin,
  ChannelCapabilities,
  AnyAgentTool,
  OpenClawConfig,
} from 'openclaw/plugin-sdk';
import type { ChannelMeta } from 'openclaw/plugin-sdk/feishu';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
import { startGatewayAgent } from './agent.js';
import { Type } from '@sinclair/typebox';

// 插件配置接口
export interface BridgePluginConfig {
  connectorBaseUrl?: string;
  connectorToken?: string;
  /** 当前用户飞书 open_id，由 Connector 写入；用于知识库搜索等需用户身份的场景 */
  feishu_open_id?: string;
  /** Agent bootstrap token — agt_boot_{openId}_{hooksToken}; triggers Gateway Agent polling mode */
  agentBootstrapToken?: string;
}

// JSON helper for tool results
function json(data: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// Channel 元信息
const meta: ChannelMeta = {
  id: 'feishu-bridge',
  label: 'Feishu Bridge',
  selectionLabel: 'Feishu Bridge (via Connector)',
  docsPath: '/channels/feishu-bridge',
  docsLabel: 'feishu-bridge',
  blurb: '飞书消息通道（通过 Connector 转发）',
  aliases: ['feishu-bridge'],
  order: 71,
};

// Channel 能力定义 - 注意使用 "direct" 和 "channel" 而非 "dm" 和 "group"
const capabilities: ChannelCapabilities = {
  chatTypes: ['direct', 'channel'],
  polls: false,
  threads: false,
  media: false,
  reactions: false,
  edit: false,
  reply: true,
};

// 发送消息到 Connector
async function sendToConnector(
  connectorBaseUrl: string,
  connectorToken: string,
  action: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const url = action.includes('/')
    ? `${connectorBaseUrl}${action}`
    : `${connectorBaseUrl}/plugin/feishu/${action}`;

  console.log(`[Bridge] Calling Connector ${url}: ${JSON.stringify(params).substring(0, 200)}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${connectorToken}`,
    },
    body: JSON.stringify(params),
  });

  const result = await response.json();
  console.log(`[Bridge] Connector response: ${JSON.stringify(result).substring(0, 200)}`);

  return result;
}

// 插件实现
const plugin = {
  id: 'neoway-feishu-bridge',
  name: 'Feishu Bridge',
  description: '飞书 Bridge 插件 - 通过 Connector 转发飞书消息',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig as BridgePluginConfig) || {};
    const connectorBaseUrl = config.connectorBaseUrl || process.env.CONNECTOR_URL || 'http://host.docker.internal:3000';
    const connectorToken = config.connectorToken || process.env.BRIDGE_TOKEN || '';
    const feishuOpenId = config.feishu_open_id;

    function bridgeHeaders(): Record<string, string> {
      const h: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${connectorToken}`,
      };
      if (feishuOpenId) h['X-User-OpenId'] = feishuOpenId;
      return h;
    }

    // 定义 Channel 插件
    const channelPlugin: ChannelPlugin<string> = {
      id: meta.id,
      meta,
      capabilities,

      // 配置适配器 - Bridge 插件不需要本地配置
      config: {
        listAccountIds: () => ['default'],
        resolveAccount: () => 'default',
      },

      // 目录服务
      directory: {
        async listPeers({ query, limit = 20 }) {
          const result = await sendToConnector(connectorBaseUrl, connectorToken, 'list_users', {
            query,
            limit,
          }) as { users?: Array<{ open_id: string; name: string }> };
          return (result.users || []).map((user) => ({
            kind: 'user' as const,
            id: user.open_id,
            name: user.name,
          }));
        },
        async listGroups({ query, limit = 20 }) {
          const result = await sendToConnector(connectorBaseUrl, connectorToken, 'list_chats', {
            query,
            limit,
          }) as { groups?: Array<{ chat_id: string; name: string }> };
          return (result.groups || []).map((chat) => ({
            kind: 'group' as const,
            id: chat.chat_id,
            name: chat.name,
          }));
        },
      },
    };

    api.registerChannel({ plugin: channelPlugin });

    // 工具 1: 发送飞书消息
    api.registerTool(
      {
        name: 'feishu_bridge_send_message',
        label: 'Feishu Bridge Send Message',
        description: '通过 Bridge 发送飞书消息（推荐使用）',
        parameters: Type.Object({
          receive_id: Type.String({ description: '接收者 ID' }),
          receive_id_type: Type.Optional(Type.Union([
            Type.Literal('open_id'),
            Type.Literal('chat_id'),
          ])),
          content: Type.String({ description: '消息内容' }),
          msg_type: Type.Optional(Type.Union([
            Type.Literal('text'),
            Type.Literal('post'),
            Type.Literal('interactive'),
          ])),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            receive_id: string;
            receive_id_type?: 'open_id' | 'chat_id';
            content: string;
            msg_type?: 'text' | 'post' | 'interactive';
          };
          try {
            const result = await sendToConnector(connectorBaseUrl, connectorToken, 'send', {
              receive_id: p.receive_id,
              receive_id_type: p.receive_id_type || 'open_id',
              content: p.content,
              msg_type: p.msg_type || 'text',
            });
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_send_message' }
    );

    // 工具 2: 获取飞书消息
    api.registerTool(
      {
        name: 'feishu_bridge_get_messages',
        label: 'Feishu Bridge Get Messages',
        description: '通过 Bridge 读取飞书消息历史',
        parameters: Type.Object({
          chat_id: Type.Optional(Type.String()),
          open_id: Type.Optional(Type.String()),
          page_size: Type.Optional(Type.Integer()),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            chat_id?: string;
            open_id?: string;
            page_size?: number;
          };
          try {
            const result = await sendToConnector(connectorBaseUrl, connectorToken, 'get_messages', {
              receive_id: p.chat_id || p.open_id,
              receive_id_type: p.chat_id ? 'chat_id' : 'open_id',
              page_size: p.page_size || 50,
            });
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_get_messages' }
    );

    // 工具 3: 知识库搜索
    api.registerTool(
      {
        name: 'feishu_bridge_kb_search',
        label: 'Feishu Bridge KB Search',
        description: '搜索企业内部知识库',
        parameters: Type.Object({
          query: Type.String({ description: '搜索关键词' }),
          kb_name: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer()),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            query: string;
            kb_name?: string;
            limit?: number;
          };
          try {
            const response = await fetch(`${connectorBaseUrl}/plugin/kb/search`, {
              method: 'POST',
              headers: bridgeHeaders(),
              body: JSON.stringify({
                query: p.query,
                kb_name: p.kb_name || 'sanbu',
                limit: p.limit || 5,
              }),
            });
            const result = await response.json();
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_kb_search' }
    );

    // 工具 3.1: 获取知识库授权链接（当 KB 搜索返回 need_auth 时，Agent 可调用此工具拿到链接并发消息给用户索要授权）
    api.registerTool(
      {
        name: 'feishu_bridge_wiki_request_auth',
        label: 'Feishu Bridge Wiki Request Auth',
        description: '获取知识库搜索授权链接。当知识库搜索提示需要授权时，调用此工具拿到链接，并发送给用户请其点击完成授权。',
        parameters: Type.Object({}),
        async execute() {
          try {
            const response = await fetch(`${connectorBaseUrl}/plugin/wiki/auth_url`, {
              method: 'GET',
              headers: bridgeHeaders(),
            });
            const result = (await response.json()) as { auth_url?: string; message?: string };
            if (result.auth_url) {
              const suggested = `要使用知识库搜索，请点击下方链接完成授权（仅需一次）：\n${result.auth_url}`;
              return json({
                ...result,
                suggested_message: suggested,
                reply_instruction:
                  '你的下一条回复必须把 auth_url 或 suggested_message 的完整内容发给用户，让用户能看到或复制链接；不可只发「请点击链接」而不带实际 URL。',
              });
            }
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_wiki_request_auth' }
    );

    // 工具 4: 获取飞书文档
    api.registerTool(
      {
        name: 'feishu_bridge_fetch_doc',
        label: 'Feishu Bridge Fetch Doc',
        description: '通过 Bridge 获取飞书文档内容',
        parameters: Type.Object({
          doc_token: Type.String(),
          node_id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params) {
          const p = params as {
            doc_token: string;
            node_id?: string;
          };
          try {
            const result = await sendToConnector(connectorBaseUrl, connectorToken, 'fetch_doc', {
              doc_token: p.doc_token,
              node_id: p.node_id,
            });
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_fetch_doc' }
    );

    // 工具 5: 飞书日历
    api.registerTool(
      {
        name: 'feishu_bridge_calendar',
        label: 'Feishu Bridge Calendar',
        description: '通过 Bridge 操作飞书日历',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('get'),
            Type.Literal('create'),
            Type.Literal('update'),
            Type.Literal('delete'),
          ]),
          calendar_id: Type.Optional(Type.String()),
          event_id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          start_time: Type.Optional(Type.String()),
          end_time: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params) {
          try {
            const result = await sendToConnector(connectorBaseUrl, connectorToken, 'calendar', params);
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_calendar' }
    );

    // 工具 6: 飞书任务
    api.registerTool(
      {
        name: 'feishu_bridge_task',
        label: 'Feishu Bridge Task',
        description: '通过 Bridge 操作飞书任务',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('get'),
            Type.Literal('create'),
            Type.Literal('complete'),
            Type.Literal('delete'),
          ]),
          task_guid: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          due: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params) {
          try {
            const result = await sendToConnector(connectorBaseUrl, connectorToken, 'task', params);
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_task' }
    );

    // 工具 7: 获取运行时状态
    api.registerTool(
      {
        name: 'feishu_bridge_get_runtime_status',
        label: 'Feishu Bridge Get Runtime Status',
        description: '获取当前用户 Gateway 容器的运行状态',
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const response = await fetch(`${connectorBaseUrl}/plugin/runtime/status`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${connectorToken}`,
              },
            });
            const result = await response.json();
            return json(result);
          } catch (err) {
            return json({ success: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: 'feishu_bridge_get_runtime_status' }
    );

    api.logger.info(`neoway-feishu-bridge plugin registered, connector: ${connectorBaseUrl}`);

    // ClawManager Pattern: Start Gateway Agent polling if bootstrap token is available.
    // The Gateway Agent polls the Connector for messages instead of Connector pushing.
    const bootstrapToken = config.agentBootstrapToken || process.env.AGENT_BOOTSTRAP_TOKEN;
    if (bootstrapToken && feishuOpenId) {
      // Run agent in background — don't block plugin registration
      startGatewayAgent(connectorBaseUrl, connectorToken, feishuOpenId, bootstrapToken)
        .catch((err) => {
          console.error('[Agent] Gateway Agent crashed:', err);
        });
    } else {
      console.log('[Bridge] No AGENT_BOOTSTRAP_TOKEN — running in passive mode (no reverse heartbeat polling)');
    }
  },
};

export default plugin;
