/**
 * Ownership Guard — ClawManager security pattern.
 * Verifies the requesting user owns the resource they're trying to access.
 * Admin users can access any resource.
 */
import type { FastifyRequest } from 'fastify';

export interface AuthContext {
  openId: string;
  isAdmin: boolean;
}

/**
 * Resolve auth context from a Fastify request.
 * Supports two modes:
 * 1. Admin JWT Bearer token (from /api/admin routes) — verified by requireAuth hook
 * 2. Agent Session Token via X-Agent-Token header (from /agent routes)
 */
export function resolveAuthContext(request: FastifyRequest): AuthContext | null {
  // JWT token has already been verified by requireAuth middleware.
  // Extract role from the decoded JWT payload attached to the request.
  const decoded = (request as any).user as { role?: string; sub?: string } | undefined;
  if (decoded?.role === 'admin') {
    return { openId: decoded.sub || 'admin', isAdmin: true };
  }
  if (decoded?.sub) {
    return { openId: decoded.sub, isAdmin: false };
  }

  // Agent session token via header (no JWT in agent routes)
  const sessionToken = request.headers['x-agent-token'] as string | undefined;
  if (sessionToken) {
    const parts = sessionToken.split('_');
    if (parts[0] === 'agt' && parts[1] === 'sess' && parts.length >= 3) {
      return { openId: parts.slice(2, -1).join('_'), isAdmin: false };
    }
  }

  return null;
}

/**
 * Check if the current auth context has permission to access the resource.
 * Admin bypasses ownership check; non-admins must own the resource.
 */
export function checkOwnership(ctx: AuthContext, resourceOpenId: string): boolean {
  return ctx.isAdmin || ctx.openId === resourceOpenId;
}

/**
 * Require ownership — returns a 403 reply if not authorized.
 */
export function requireOwnership(
  ctx: AuthContext,
  resourceOpenId: string,
  reply: { status: (code: number) => { send: (body: unknown) => void } }
): boolean {
  if (!checkOwnership(ctx, resourceOpenId)) {
    reply.status(403).send({ error: 'Forbidden: not owner of this resource' });
    return false;
  }
  return true;
}
