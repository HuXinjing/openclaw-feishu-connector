# OpenClaw Feishu Connector

A production-grade Feishu (Lark) multi-user connector for [OpenClaw](https://github.com/openclaw/openclaw). Manages per-user Docker containers, network ACLs, organization sync, and an admin dashboard — all through Feishu.

## Features

- **Multi-user container isolation** — Each Feishu user gets their own Docker container running OpenClaw Gateway
- **Feishu organization sync** — BFS traversal syncs users and departments into network profiles
- **Per-user network ACLs** — IP allowlisting per user/department via iptables rules inside containers
- **Container pooling** — Pre-warmed containers for fast cold-start; sleep/wake on cron schedules
- **Admin dashboard** — Web UI for user management, container lifecycle, network ACL editing, CSV import/export
- **Runtime config** — System parameters (pool size, idle timeout, health check interval, etc.) editable without restart
- **Bridge plugin** — Feishu Bridge integration for multi-org routing via OpenClaw plugins
- **Cost logging** — Per-user, per-model AI cost tracking with MySQL persistence

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Feishu Cloud                                       │
│  WebSocket ←── Feishu Connector (port 3000)          │
└────────────────┬──────────────────────────────────┘
                 │ routes messages
                 ▼
┌─────────────────────────────────────────────────────┐
│  OpenClaw Feishu Connector                         │
│  ┌──────────┐  ┌───────────┐  ┌───────────────┐ │
│  │ Admin UI │  │ Container │  │ Feishu Sync   │ │
│  │ (port    │  │ Pool Mgr  │  │ (org BFS)     │ │
│  │ 3001)    │  │           │  │               │ │
│  └──────────┘  └─────┬─────┘  └───────────────┘ │
│                     │                            │
│              ┌──────▼──────┐                     │
│              │ Docker Host │                     │
│              │ ┌────────┐  │  ┌──────────────┐  │
│              │ │User 1  │  │  │ Network ACL  │  │
│              │ │Container│  │  │  (iptables)  │  │
│              │ └────────┘  │  └──────────────┘  │
│              │ ┌────────┐  │                     │
│              │ │User 2  │  │                    │
│              │ │Container│  │                    │
│              │ └────────┘  │                    │
│              └─────────────┘                     │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+
- Docker (with Docker socket accessible)
- MySQL 8.0+ (or use SQLite for development)
- A Feishu application (create at https://open.feishu.cn/app)

### Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_ORG/openclaw-feishu-connector.git
cd openclaw-feishu-connector

# Install dependencies
cd connector && npm install && cd ..
cd bridge-plugin && npm install && npm run build && cd ..

# Configure environment
cp .env.example .env
# Edit .env with your Feishu app credentials and secrets

# Start services
docker-compose up -d

# Or run locally (two terminals):
cd connector && npx tsx src/index.ts           # Connector on port 3000
cd connector && npx tsx src/admin/index.ts   # Admin on port 3001
```

### Feishu App Configuration

1. Create a Feishu app at https://open.feishu.cn/app
2. Enable **Bot** capability
3. Enable **WebSocket** message subscription
4. Set permissions: `im:message`, `im:message.receive_v1`, `contact:user.base:readonly`, `docx:document:readonly`
5. Add redirect URL for OAuth: `https://your-domain.com/api/feishu/oauth/callback`

### Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Description |
|----------|-------------|
| `FEISHU_APP_ID` | Feishu application ID |
| `FEISHU_APP_SECRET` | Feishu application secret |
| `ADMIN_JWT_SECRET` | JWT signing secret (generate with `openssl rand -hex 32`) |
| `UAT_MASTER_KEY` | Encryption key for user tokens (generate with `openssl rand -hex 32`) |
| `MYSQL_HOST` | MySQL host (defaults to `127.0.0.1`) |
| `MYSQL_PASSWORD` | MySQL password |

## Project Structure

```
.
├── connector/            # Main connector service (Fastify + TypeScript)
│   ├── src/
│   │   ├── index.ts         # WebSocket connector entry
│   │   ├── admin/          # Admin REST API + HTML dashboard
│   │   ├── agent/          # Per-user session management
│   │   ├── lib/            # Feishu sync, network ACL, DLQ, cost logging
│   │   ├── store/          # MySQL/SQLite persistence layer
│   │   └── core/           # Token encryption, shared utilities
│   └── skills/             # Connector-built-in skills
├── bridge-plugin/       # OpenClaw Bridge plugin for multi-org routing
├── connector-sdk/       # TypeScript SDK for plugins to call connector APIs
├── docs/                # Architecture and operation docs
└── docker-compose.yaml  # Full-stack Docker deployment
```

## License

MIT
