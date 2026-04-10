/**
 * DLQ admin routes
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDLQ, retryDLQ, resolveDLQ, getDLQStats } from '../../lib/dlq.js';
import { requireAuth } from '../middleware.js';

export function registerDLQRoutes(fastify: any) {
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);

    f.get('/api/admin/dlq', async () => ({
      entries: getDLQ(),
      stats: getDLQStats(),
    }));

    f.post('/api/admin/dlq/:id/retry', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const ok = retryDLQ(parseInt(id));
      if (!ok) return reply.status(404).send({ error: 'Not found' });
      return { success: true };
    });

    f.post('/api/admin/dlq/:id/resolve', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      resolveDLQ(parseInt(id));
      return { success: true };
    });
  });
}
