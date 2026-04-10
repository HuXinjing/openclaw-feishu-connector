/**
 * Content Moderation Admin API — ClawManager pattern.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware.js';
import { resolveAuthContext } from '../../lib/ownership.js';
import { getModerationRules, addModerationRule, removeModerationRule } from '../../lib/moderation.js';
import type { ModerationRule } from '../../types.js';

export function registerModerationRoutes(fastify: any): void {
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);

    // GET /api/admin/moderation/rules — list all rules
    f.get('/api/admin/moderation/rules', async () => {
      return { rules: getModerationRules() };
    });

    // POST /api/admin/moderation/rules — add a rule (admin only)
    f.post('/api/admin/moderation/rules', async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = resolveAuthContext(request);
      if (!ctx?.isAdmin) {
        return reply.status(403).send({ error: 'Admin only' });
      }
      const body = request.body as { rule: ModerationRule };
      if (!body.rule?.id || !body.rule?.pattern || !body.rule?.action) {
        return reply.status(400).send({ error: 'Missing required fields: id, pattern, action' });
      }
      addModerationRule(body.rule);
      return { success: true, rule: body.rule };
    });

    // DELETE /api/admin/moderation/rules/:ruleId — remove a rule (admin only)
    f.delete('/api/admin/moderation/rules/:ruleId', async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = resolveAuthContext(request);
      if (!ctx?.isAdmin) {
        return reply.status(403).send({ error: 'Admin only' });
      }
      const { ruleId } = request.params as { ruleId: string };
      const removed = removeModerationRule(ruleId);
      if (!removed) {
        return reply.status(404).send({ error: 'Rule not found' });
      }
      return { success: true };
    });
  });
}
