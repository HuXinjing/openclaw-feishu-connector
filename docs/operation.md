# PlanC Operation Guide

## Configuration

### Feishu App Permissions (Required for Network ACL)

The Network ACL feature syncs user data from Feishu's contact directory. The following permissions must be added to your Feishu app **before** syncing will work:

1. Open [Feishu Open Platform](https://open.feishu.cn) → Your App → **Permissions & Scopes**
2. Add these permissions scopes:
   - **获取部门基础信息** (`contact:department:readonly`) — read department tree
   - **获取用户基础信息** (`contact:user.base:readonly`) — read user name, avatar, department
3. **Publish a new version** of the app and wait for your enterprise admin to approve it

Without these permissions, "全量同步" will return 0 users with errors: `no dept authority error`.

### Connector (.env)

```bash
# Feishu App Credentials
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx

# Connector Server
CONNECTOR_PORT=3000
CONNECTOR_TOKEN=your-secure-token-here

# Docker
DOCKER_HOST=unix:///var/run/docker.sock
OPENCLAW_IMAGE=openclaw-gateway:latest
DATA_DIR=./data

# Gateway Pool
GATEWAY_BASE_PORT=18799
GATEWAY_HOOKS_TOKEN_SALT=your-salt-here
GATEWAY_MAX_IDLE_MINUTES=30

# UAT Token Encryption
UAT_MASTER_KEY=32-byte-hex-key-here

# Optional
LOG_LEVEL=info
```

### Bridge Plugin (openclaw.json)

```json
{
  "plugins": [{
    "id": "neoway-feishu-bridge",
    "config": {
      "connectorBaseUrl": "http://host.docker.internal:3000",
      "connectorToken": "your-secure-token-here",
      "dmPolicy": "open",
      "groupPolicy": "restricted",
      "allowFrom": ["ou_xxxxxxxx", "ou_yyyyyyyyyy"],
      "requireMention": true
    }
  }]
}
```

## Monitoring Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /health` | any | Basic health check |
| `GET /healthz` | any | Readiness probe |
| `GET /api/users` | GET | List all users (token required) |
| `GET /api/users/:openId` | GET | Get user details |
| `POST /api/users` | POST | Register new user |
| `DELETE /api/users/:openId` | DELETE | Remove user |
| `GET /api/containers` | GET | List container status |
| `GET /api/containers/:openId/stop` | POST | Stop user container |
| `GET /api/containers/:openId/restart` | POST | Restart user container |
| `POST /api/skills/broadcast` | POST | Hot-reload skills |
| `DELETE /api/skill-cache` | DELETE | Clear ETag cache |

## Troubleshooting

### User container won't start
```
1. Check Docker is running: docker ps
2. Check image exists: docker images | grep openclaw
3. Check port availability: ss -ltnp | grep 18799
4. View container logs: docker logs openclaw-{sanitizedOpenId}
5. Check connector logs for gateway auth timeout
```

### Messages not delivered
```
1. Check user phase: GET /api/users/{openId}
   - If not 'active': container not ready
2. Check MessageDedup: same event_id within 60s is dropped
3. Check MessageQueueBuffer: flushes every 2s, check for stuck queue
4. Check gateway responds: look for "timeout" in connector logs
```

### Knowledge base search returns "need_auth"
```
1. User has not completed OAuth flow
2. Bridge plugin should call feishu_bridge_wiki_request_auth
3. Send the auth URL to user, wait for them to authorize
4. Token stored encrypted at ~/.local/share/openclaw-feishu-uat/
```

### Container in 'creating' phase forever
```
1. Docker pull may be slow: docker images to check
2. Container may be stuck: docker ps -a | grep openclaw
3. Check docker daemon: docker info
4. Force cleanup: POST /api/containers/{openId}/stop then DELETE user
```

## Skill Update Procedure

When updating skills on all running containers:

1. Update skill files in `connector/skills/`
2. Commit changes
3. Broadcast to containers:
   ```bash
   curl -X POST http://localhost:3000/api/skills/broadcast \
     -H "Authorization: Bearer $CONNECTOR_TOKEN"
   ```
4. Each Gateway container receives new skill via Hooks API and merges with existing content (builtin markers preserved)

## Container Naming

Container names use sanitized open_id (prefix `openclaw-` + sanitized open_id, where `/` and `.` are replaced with `-`). This prevents double-prefix issues.

## Message Deduplication

`MessageDedup` uses a TTL cache (60s, 1000 max entries). On Feishu WS reconnect, the server replays recent events — the dedup filter prevents these from being processed twice. Cleanup happens lazily at 90% capacity.

## API Reference: Bridge Plugin Tools

| Tool | Description |
|------|-------------|
| `feishu_bridge_send_message` | Send text/post/interactive message |
| `feishu_bridge_get_messages` | Read message history |
| `feishu_bridge_kb_search` | Search knowledge base |
| `feishu_bridge_wiki_request_auth` | Get OAuth auth URL |
| `feishu_bridge_fetch_doc` | Get Feishu doc content |
| `feishu_bridge_calendar` | List/create/update/delete calendar events |
| `feishu_bridge_task` | List/create/complete/delete tasks |
| `feishu_bridge_get_runtime_status` | Get container runtime status |
