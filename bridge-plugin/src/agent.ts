/**
 * Gateway Agent — ClawManager reverse heartbeat pattern.
 *
 * Runs inside the Gateway Container alongside the OpenClaw Core.
 * Polls the Connector every 15s for pending messages and commands,
 * instead of Connector pushing to Gateway.
 *
 * Environment:
 *   AGENT_BOOTSTRAP_TOKEN  — agt_boot_{openId}_{hooksToken}, from Connector user record
 *   CONNECTOR_URL          — Connector base URL (default: http://host.docker.internal:3000)
 *   BRIDGE_TOKEN          — Token for Bridge->Connector auth
 */

interface AgentHeartbeatResponse {
  ok: boolean;
  desiredPowerState: 'running' | 'stopped';
  pendingCommands: Array<{
    commandId: string;
    type: string;
    payload?: Record<string, unknown>;
    issuedAt: number;
  }>;
  pendingMessageIds: string[];
}

interface AgentRegisterResponse {
  sessionToken: string;
  heartbeatIntervalMs: number;
  sessionExpiresAt: number;
  connectorVersion: string;
}

interface MessageContent {
  eventId: string;
  content: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call POST /agent/register on the Connector.
 */
async function agentRegister(
  connectorUrl: string,
  bridgeToken: string,
  bootstrapToken: string
): Promise<AgentRegisterResponse> {
  const res = await fetch(`${connectorUrl}/agent/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bridgeToken}`,
    },
    body: JSON.stringify({ bootstrapToken }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Agent register failed (${res.status}): ${err}`);
  }

  return res.json() as Promise<AgentRegisterResponse>;
}

/**
 * Call POST /agent/heartbeat on the Connector.
 */
async function agentHeartbeat(
  connectorUrl: string,
  bridgeToken: string,
  sessionToken: string,
  status: 'running' | 'idle' | 'error' = 'running'
): Promise<AgentHeartbeatResponse & { _code?: string }> {
  const res = await fetch(`${connectorUrl}/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bridgeToken}`,
      'X-Session-Token': sessionToken,
    },
    body: JSON.stringify({ sessionToken, status }),
  });

  if (!res.ok) {
    const body = await res.json() as { code?: string; error?: string };
    return { ok: false, desiredPowerState: 'running', pendingCommands: [], pendingMessageIds: [], _code: body.code || String(res.status) };
  }

  return res.json() as Promise<AgentHeartbeatResponse & { _code?: string }>;
}

/**
 * Fetch a message's content by eventId.
 */
async function fetchMessageContent(
  connectorUrl: string,
  bridgeToken: string,
  eventId: string
): Promise<MessageContent> {
  const res = await fetch(`${connectorUrl}/agent/messages/${encodeURIComponent(eventId)}`, {
    headers: {
      'Authorization': `Bearer ${bridgeToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch message ${eventId}: ${res.status}`);
  }

  return res.json() as Promise<MessageContent>;
}

/**
 * Send a message to Feishu via Connector's plugin endpoint.
 */
async function sendFeishuMessage(
  connectorUrl: string,
  bridgeToken: string,
  feishuOpenId: string,
  text: string
): Promise<void> {
  await fetch(`${connectorUrl}/plugin/feishu/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bridgeToken}`,
      'X-User-OpenId': feishuOpenId,
    },
    body: JSON.stringify({
      receive_id: feishuOpenId,
      receive_id_type: 'open_id',
      content: text,
      msg_type: 'text',
    }),
  });
}

/**
 * Execute a command received from the Connector.
 */
async function executeCommand(
  type: string,
  _payload?: Record<string, unknown>
): Promise<void> {
  console.log(`[Agent] Executing command: ${type}`);
  switch (type) {
    case 'reload_skills':
      // In a real implementation, this would trigger a skills reload
      console.log('[Agent] reload_skills — would trigger skill reload');
      break;
    case 'restart':
      console.log('[Agent] restart — would trigger gateway restart');
      break;
    case 'stop':
      console.log('[Agent] stop — would trigger gateway stop');
      break;
    default:
      console.warn(`[Agent] Unknown command type: ${type}`);
  }
}

/**
 * Process a single message — send to OpenClaw Core and reply to Feishu.
 * In a real implementation, this would call the OpenClaw agent API.
 */
async function processMessage(
  connectorUrl: string,
  bridgeToken: string,
  feishuOpenId: string,
  content: string
): Promise<void> {
  console.log(`[Agent] Processing message for ${feishuOpenId}: ${content.substring(0, 100)}...`);

  // TODO: Call OpenClaw Core agent API with the message content.
  // This would be: POST /agent/message with the message, get back the response.
  // For now, simulate a response.
  const response = `[Gateway Agent] Received: ${content.substring(0, 50)}... (processed by Gateway)`;

  try {
    await sendFeishuMessage(connectorUrl, bridgeToken, feishuOpenId, response);
    console.log(`[Agent] Sent response to Feishu user ${feishuOpenId}`);
  } catch (err) {
    console.error(`[Agent] Failed to send response:`, err);
  }
}

/**
 * Start the Gateway Agent polling loop.
 * Exported so it can be called from the plugin's register() function or as a standalone entry.
 */
export async function startGatewayAgent(
  connectorUrl: string,
  bridgeToken: string,
  feishuOpenId: string,
  bootstrapToken: string
): Promise<void> {
  console.log('[Agent] Starting Gateway Agent...');
  console.log(`[Agent] Connector URL: ${connectorUrl}`);
  console.log(`[Agent] User: ${feishuOpenId}`);

  // Step 1: Register with Connector to get session token
  let sessionToken: string;
  let heartbeatIntervalMs = 15_000;

  try {
    const reg = await agentRegister(connectorUrl, bridgeToken, bootstrapToken);
    sessionToken = reg.sessionToken;
    heartbeatIntervalMs = reg.heartbeatIntervalMs;
    console.log(`[Agent] Registered. Session expires: ${new Date(reg.sessionExpiresAt).toISOString()}`);
  } catch (err) {
    console.error('[Agent] Failed to register with Connector:', err);
    throw err;
  }

  // Step 2: Polling loop
  while (true) {
    try {
      const heartbeat = await agentHeartbeat(connectorUrl, bridgeToken, sessionToken);

      // Check if session expired — re-register
      if (!heartbeat.ok || (heartbeat as any)._code === 'SESSION_EXPIRED') {
        console.warn('[Agent] Session expired, re-registering...');
        const reg = await agentRegister(connectorUrl, bridgeToken, bootstrapToken);
        sessionToken = reg.sessionToken;
        heartbeatIntervalMs = reg.heartbeatIntervalMs;
        console.log(`[Agent] Re-registered. Session expires: ${new Date(reg.sessionExpiresAt).toISOString()}`);
        continue;
      }

      // Execute pending commands
      for (const cmd of heartbeat.pendingCommands) {
        await executeCommand(cmd.type, cmd.payload);
      }

      // Fetch and process pending messages
      for (const eventId of heartbeat.pendingMessageIds) {
        try {
          const msg = await fetchMessageContent(connectorUrl, bridgeToken, eventId);
          await processMessage(connectorUrl, bridgeToken, feishuOpenId, msg.content);
        } catch (err) {
          console.error(`[Agent] Failed to process message ${eventId}:`, err);
        }
      }

      // Check for new session token in response headers (auto-refresh)
      // (In practice, the connector sets X-Session-Token header on the heartbeat response)

    } catch (err) {
      console.error('[Agent] Heartbeat error:', err);
    }

    await sleep(heartbeatIntervalMs);
  }
}
