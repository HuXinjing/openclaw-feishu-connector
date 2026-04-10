/**
 * 飞书 Connector 核心类型定义
 */

// 飞书 Webhook 事件类型
export interface FeishuWebhookEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: FeishuMessageEvent;
}

// 飞书消息事件
export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: 'user' | 'app';
  };
  message: {
    message_id: string;
    thread_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: 'group' | 'p2p';
    message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media';
    content: string;
  };
}

// 用户映射表条目
export interface UserMapping {
  id: number;
  open_id: string;
  user_name?: string;
  gateway_url: string;
  gateway_token: string;      // 用于 hooks API
  gateway_auth_token?: string; // 用于 OpenAI 兼容 API
  container_id?: string;
  port?: number;              // 宿主机端口
  status: 'pending' | 'active' | 'pooled' | 'stopped' | 'error';
  created_at: number;
  updated_at: number;
  last_active?: number;
}

/**
 * FeishuUserRecord — structured user record used by router.ts (Task 2+.
 * Phase-driven status replaces the flat `status` string.
 */
export interface FeishuUserChannelPolicy {
  dmPolicy: 'open' | 'restricted' | 'disabled';
  groupPolicy: 'open' | 'restricted' | 'disabled';
  allowFrom: string[];
  groupAllowFrom: string[];
  requireMention: boolean;
}

export interface FeishuUserPhase {
  phase: '' | 'pending' | 'active' | 'pooled' | 'stopped' | 'error' | 'failed';
  containerId?: string;
  gatewayAuthToken?: string;
  gatewayUrl?: string;
  port?: number;
  retryCount?: number;
  lastError?: string;
  sessionToken?: string;       // agt_sess_xxx, 24h valid
  sessionExpiresAt?: number;   // Date.now() + 24h
}

export interface FeishuUserSpec {
  feishuOpenId: string;
  userName?: string;
  feishuUserName?: string;  // alias for userName
  hooksToken: string;     // same as gateway_token
  tenantKey?: string;    // Feishu tenant_key for multi-tenant support
  permissions?: string[];
  poolStrategy?: 'on-demand' | 'warm' | 'cold';
  channelPolicy?: FeishuUserChannelPolicy;
}

export interface FeishuUserLastSpec {
  hash: string;
  spec: FeishuUserSpec;
}

export interface FeishuUserRecord {
  id: number;
  spec: FeishuUserSpec;
  status: FeishuUserPhase;
  createdAt: number;
  updatedAt: number;
  lastActive?: number;
  lastSpec?: FeishuUserLastSpec;
}

// Gateway Hooks API 请求
export interface GatewayHookRequest {
  message: string;
  name?: string;
  agentId?: string;
  sessionKey?: string;
  wakeMode?: 'now' | 'next-heartbeat';
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: 'low' | 'high' | 'medium';
  timeoutSeconds?: number;
  idempotencyKey?: string;
}

// Gateway Hooks API 响应
export interface GatewayHookResponse {
  ok: boolean;
  runId?: string;
  text?: string;  // 直接返回的文本响应
  error?: string;
}

// 飞书发送消息请求
export interface FeishuSendMessageRequest {
  receive_id: string;
  receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'chat_id';
  msg_type: 'text' | 'post' | 'image' | 'file' | 'interactive';
  content: string;
}

// 容器配置
export interface ContainerConfig {
  image: string;
  env: Record<string, string>;
  binds: string[];
  ports: number;
  name: string;
}

// ========== Task 12: Thread Session Support ==========
/**
 * Extract thread ID from a Feishu message event.
 * Thread ID is in thread_id (reply-to thread root), root_id (thread root),
 * or parent_id (nested reply).
 */
export function getThreadId(event: FeishuMessageEvent): string | undefined {
  return event.message?.thread_id || event.message?.root_id || event.message?.parent_id;
}

// ========== ClawManager Pattern: Agent Session Types ==========
export interface AgentRegistrationRequest {
  bootstrapToken: string;    // agt_boot_{openId}_{hooksToken}
  openclawVersion?: string;
  runtimeInfo?: {
    platform: string;
    arch: string;
    skills: string[];
  };
}

export interface AgentRegistrationResponse {
  sessionToken: string;
  heartbeatIntervalMs: number;
  sessionExpiresAt: number;
  connectorVersion: string;
}

export interface AgentHeartbeatRequest {
  sessionToken: string;
  status: 'running' | 'idle' | 'error';
  activeSessionCount?: number;
  loadedSkills?: string[];
  lastError?: string;
}

export interface AgentHeartbeatResponse {
  ok: boolean;
  desiredPowerState: 'running' | 'stopped';
  desiredConfigRevisionId?: string;
  pendingCommands: AgentCommand[];
  pendingMessageIds: string[]; // eventIds of queued Feishu messages
}

export interface AgentCommand {
  commandId: string;
  type: 'reload_skills' | 'restart' | 'stop';
  payload?: Record<string, unknown>;
  issuedAt: number;
}

export interface QueuedMessageRef {
  eventId: string;
  sessionKey: string;
  chatType: string;
  threadId?: string;
  enqueuedAt: number;
}

export interface ModerationRule {
  id: string;
  pattern: string;
  action: 'allow' | 'block' | 'flag';
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface UserQuota {
  openId: string;
  maxContainers: number;
  maxCpuCores: number;
  maxMemoryMB: number;
  maxIdleMinutes: number;
  maxMessageRate: number;
}

// ========== Task 1: UserNetworkProfile ==========
export interface UserNetworkProfile {
  open_id: string;           // FK to users.feishu_open_id
  allowed_ips: string[];      // JSON array, e.g. ['10.0.1.0/24','10.0.3.50']; '0.0.0.0/0' = all internal IPs allowed
  allow_external: boolean;    // true = full external internet access (default), false = internal only
  department_id: string | null;
  department_name: string | null;
  user_name: string | null;
  avatar_url: string | null;
  synced_at: number | null;   // unix timestamp of last Feishu sync
  updated_at: number | null;   // unix timestamp of last admin edit
  updated_by: string | null;   // admin who last edited
}

// ========== Connector Config ==========
export interface ConnectorConfig {
  port: number;
  feishu: {
    app_id: string;
    app_secret: string;
    encrypt_key: string;
    verification_token: string;
  };
  docker: {
    host: string;
    port: number;
    openclaw_image: string;
    data_dir: string;
  };
  gateway: {
    base_port: number;
    hooks_token_salt: string;
  };
  admin: {
    jwtSecret: string;
    username: string;
    password: string;
  };
}
