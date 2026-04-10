/**
 * Agent routes — Gateway Agent register and heartbeat endpoints.
 * ClawManager pattern: Gateway Agent polls Connector instead of Connector pushing.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { findUserByOpenId } from '../user-map.js';
import { shouldRefreshSession, buildRefreshedSession } from './session-manager.js';
import { dequeueUserMessages } from './message-queue.js';
import { checkIdempotency, setIdempotency, buildHeartbeatIdempotencyKey } from '../lib/idempotency.js';
import type {
  AgentRegistrationRequest,
  AgentRegistrationResponse,
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
} from '../types.js';

// Agent command queue: openId -> pending commands
const pendingCommands = new Map<string, import('../types.js').AgentCommand[]>();

// Message content store: eventId -> message content (cleared after fetch)
const messageContentStore = new Map<string, string>();

/**
 * Parse openId from a bootstrap or session token.
 * Token format: agt_boot_{openId}_{hooksToken} or agt_sess_{openId}_{uuid}
 */
export function parseOpenIdFromToken(token: string): string | null {
  const parts = token.split('_');
  if (parts.length < 3) return null;
  if ((parts[0] !== 'agt') || (parts[1] !== 'boot' && parts[1] !== 'sess')) return null;
  // openId may contain underscores, so join everything between parts[1] and the last part
  return parts.slice(2, -1).join('_');
}

export function registerAgentRoutes(fastify: any): void {
  // POST /agent/register — Gateway Container starts and calls this
  fastify.post('/agent/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as AgentRegistrationRequest;
    const { bootstrapToken } = body;

    if (!bootstrapToken) {
      return reply.status(400).send({ error: 'Missing bootstrapToken' });
    }

    const openId = parseOpenIdFromToken(bootstrapToken);
    if (!openId) {
      return reply.status(401).send({ error: 'Invalid bootstrap token format' });
    }

    const user = findUserByOpenId(openId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Validate bootstrap token: expected format agt_boot_{openId}_{hooksToken}
    const expectedToken = `agt_boot_${openId}_${user.spec.hooksToken}`;
    if (bootstrapToken !== expectedToken) {
      return reply.status(401).send({ error: 'Invalid bootstrap token' });
    }

    // Generate 24h session token
    const sessionToken = `agt_sess_${openId}_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Date.now();
    const sessionExpiresAt = now + 24 * 60 * 60 * 1000;

    // Update user status with session info
    user.status.sessionToken = sessionToken;
    user.status.sessionExpiresAt = sessionExpiresAt;

    const response: AgentRegistrationResponse = {
      sessionToken,
      heartbeatIntervalMs: 15_000,
      sessionExpiresAt,
      connectorVersion: '1.0.0',
    };

    return response;
  });

  // POST /agent/heartbeat — Gateway Agent polls every 15s
  fastify.post('/agent/heartbeat', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as AgentHeartbeatRequest;
    const { sessionToken, status, activeSessionCount, loadedSkills, lastError } = body;

    const openId = parseOpenIdFromToken(sessionToken);
    if (!openId) {
      return reply.status(401).send({ error: 'Invalid session token format' });
    }

    const user = findUserByOpenId(openId);
    if (!user || user.status.sessionToken !== sessionToken) {
      return reply.status(401).send({ error: 'Session not found or expired' });
    }

    // Task 7: Idempotency — prevent duplicate heartbeat processing
    const ik = buildHeartbeatIdempotencyKey(openId, sessionToken.slice(-8));
    const cached = checkIdempotency(ik);
    if (cached) return cached.response as AgentHeartbeatResponse;

    // Check expiry
    const now = Date.now();
    if (user.status.sessionExpiresAt && user.status.sessionExpiresAt < now) {
      return reply.status(401).send({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    }

    // Update last active time
    user.lastActive = now;

    // Check if session needs refresh and refresh proactively
    if (shouldRefreshSession(user.status.sessionExpiresAt)) {
      const refreshed = buildRefreshedSession(openId);
      user.status.sessionToken = refreshed.token;
      user.status.sessionExpiresAt = refreshed.expiresAt;
      reply.header('X-Session-Token', refreshed.token);
      reply.header('X-Session-Expires-At', String(refreshed.expiresAt));
    }

    // Update error status
    if (status === 'error' && lastError) {
      user.status.lastError = lastError;
    }

    // Collect pending commands for this user
    const commands = pendingCommands.get(openId) || [];
    pendingCommands.delete(openId);

    // Dequeue pending messages and return their eventIds
    const pendingMessages = dequeueUserMessages(openId);
    const pendingMessageIds = pendingMessages.map(m => m.eventId);

    // Store message content for later retrieval
    for (const msg of pendingMessages) {
      messageContentStore.set(msg.eventId, msg.content);
    }

    const response: AgentHeartbeatResponse = {
      ok: true,
      desiredPowerState: 'running',
      pendingCommands: commands,
      pendingMessageIds,
    };

    // Task 7: Record response for idempotency
    setIdempotency(ik, response);

    return response;
  });

  // GET /agent/messages/:eventId — Gateway Agent fetches message content
  fastify.get('/agent/messages/:eventId', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { eventId: string };
    const eventId = params.eventId;
    const content = messageContentStore.get(eventId);
    if (content === undefined) {
      return reply.status(404).send({ error: 'Message not found or already fetched' });
    }
    messageContentStore.delete(eventId);
    return { eventId, content };
  });
}

/**
 * Enqueue a command for a user's Gateway Agent to pick up on next heartbeat.
 */
export function enqueueAgentCommand(openId: string, command: import('../types.js').AgentCommand): void {
  const existing = pendingCommands.get(openId) || [];
  existing.push(command);
  pendingCommands.set(openId, existing);
}

/**
 * Store message content for a given eventId (called by router.ts).
 */
export function storeAgentMessage(eventId: string, content: string): void {
  messageContentStore.set(eventId, content);
}

/**
 * Get pending commands count for a user (for testing/admin).
 */
export function getPendingCommandCount(openId: string): number {
  return (pendingCommands.get(openId) || []).length;
}
