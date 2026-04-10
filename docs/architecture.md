# PlanC Architecture

> Feishu Multi-User AI Agent Connector for OpenClaw

## Overview

PlanC connects Feishu users to OpenClaw Gateway containers. Each user gets their own isolated Gateway container, accessed via the Bridge plugin through the central Connector server.

## Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Feishu Server                                  │
│  - Receives messages from users (p2p + group)           │
│  - Delivers via Webhook to Connector                    │
│  - Sends replies from Gateway back to users             │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP POST (webhook events)
┌────────────────────▼────────────────────────────────────┐
│  Layer 2: Connector (Node.js / Express)                  │
│  - Manages user registry + container pool                │
│  - Routes messages to correct Gateway container          │
│  - Handles lifecycle (create/stop/restart containers)   │
│  - Applies gate policies (dmPolicy/groupPolicy)          │
│  - Buffers + dedupes messages                           │
│  - Manages UAT tokens (AES-256-GCM encrypted)           │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP POST /ws + Hooks API
┌────────────────────▼────────────────────────────────────┐
│  Layer 3: Gateway Containers (OpenClaw)                 │
│  - One container per user                               │
│  - Runs Bridge plugin → talks to Connector              │
│  - Runs user skills (RAG, calendar, tasks, etc.)        │
│  - One Gateway per Feishu user                          │
└─────────────────────────────────────────────────────────┘
```

## State Model: Spec / Status

Each user has two layers of state (inspired by Kubernetes CRD design):

### FeishuUserSpec (desired state)
```typescript
interface FeishuUserSpec {
  feishuOpenId: string;
  userName?: string;
  hooksToken: string;
  permissions?: string[];
  poolStrategy?: 'on-demand' | 'warm' | 'cold';
  channelPolicy?: {
    dmPolicy: 'open' | 'restricted' | 'disabled';
    groupPolicy: 'open' | 'restricted' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    requireMention: boolean;
  };
}
```

### FeishuUserStatus (observed state)
```typescript
interface FeishuUserPhase {
  phase: '' | 'pending' | 'active' | 'pooled' | 'stopped' | 'error' | 'failed';
  containerId?: string;
  gatewayUrl?: string;
  gatewayAuthToken?: string;
  port?: number;
  retryCount?: number;
  lastError?: string;
}
```

**Stale Object Refresh**: Before writing to user status after any async operation (gateway auth, container start, etc.), the router re-reads the user record to prevent concurrent updates from overwriting each other.

## Message Flow

### Inbound (User → Gateway)
1. Feishu sends webhook event to `POST /feishu/webhook`
2. Connector validates + deduplicates via `MessageDedup` (60s TTL)
3. Connector checks gate policies via `checkMessageGate()`
4. Message is enqueued in `MessageQueueBuffer` (2s coalesce window)
5. Queue manager checks user phase:
   - **active**: immediately delivers to Gateway via Hooks API
   - **pending/pooled**: retries up to 60s with user notifications
   - **error/stopped**: returns "容器未运行" message
6. Gateway processes and responds; Connector delivers reply to Feishu

### Outbound (Gateway → User)
- Gateway calls Bridge tool → Connector `POST /plugin/feishu/send`
- Bridge tools (send, calendar, task, wiki) all check `checkMessageGate()`
- `ChannelOutboundAdapter` provides `sendReply`, `sendTypingIndicator`, `updateMessage`

## Container Lifecycle

| Phase | Description |
|-------|-------------|
| `pending` | User exists, no container yet |
| `creating` | Docker container being created |
| `active` | Container running, Gateway responding |
| `pooled` | Container running but idle (warm pool) |
| `stopping` | Container being stopped |
| `stopped` | Container stopped |
| `error` | Container failed to start |
| `failed` | Provisioning permanently failed |

### Pool Strategies
- **on-demand** (default): Create container on first message, stop after `maxIdleMinutes`
- **warm**: Keep container running indefinitely
- **cold**: Always create fresh container

## Skill Loading

Skills are loaded from the Connector's `skills/` directory and broadcast to all active Gateway containers on startup or skill update. The `builtin-merge` pattern preserves user customizations:

```
<!-- builtin-start -->  ← preserved, do not overwrite
user custom content
<!-- builtin-end -->
```

ETag-based caching avoids re-downloading unchanged skill packages.

## OAuth / UAT Token Management

UAT tokens are stored encrypted at:
- Linux: `~/.local/share/openclaw-feishu-uat/`
- macOS: `~/Library/Application Support/openclaw-feishu-uat/`

Storage format: AES-256-GCM encrypted (`base64(iv || authTag || ciphertext)`). Master key from `UAT_MASTER_KEY` env var. Tokens refreshed proactively 5 minutes before expiry.

## Thread Sessions

Session keys include thread context to support Feishu thread-scoped conversations:
- DM: `openId`
- Thread: `openId:thread:{threadId}`

Thread ID extracted from `event.message.thread_id` → `root_id` → `parent_id`.
