/**
 * Multi-tenant support for planC.
 * Allows running a single connector for multiple Feishu tenants.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface TenantContext {
  tenantKey: string;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
}

const tenantMap = new Map<string, TenantContext>();

export function registerTenant(tenantKey: string, ctx: TenantContext) {
  tenantMap.set(tenantKey, ctx);
  console.log(`[Tenant] Registered tenant: ${tenantKey}`);
}

export function resolveTenant(tenantKey: string): TenantContext | undefined {
  return tenantMap.get(tenantKey);
}

export function createTenantMiddleware(fastify: { addHook: (name: string, fn: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => void }) {
  fastify.addHook('preHandler', async (req, reply) => {
    const tenantKey = req.headers['x-feishu-tenant-key'] as string;
    if (!tenantKey) return reply.status(400).send({ error: 'Missing x-feishu-tenant-key header' });
    const ctx = resolveTenant(tenantKey);
    if (!ctx) return reply.status(404).send({ error: `Tenant '${tenantKey}' not found` });
    (req as FastifyRequest & { tenant: TenantContext }).tenant = ctx;
  });
}

export function hasTenants(): boolean {
  return tenantMap.size > 0;
}
