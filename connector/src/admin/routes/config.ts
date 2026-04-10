/**
 * System config REST API — runtime admin settings
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware.js';
import {
  getAllSystemConfig,
  getSystemConfig,
  setSystemConfig,
  SYSTEM_CONFIG_DEFS,
} from '../../lib/system-config.js';

export function registerConfigRoutes(fastify: FastifyInstance) {
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);

    // GET /api/admin/config — all config entries
    f.get('/api/admin/config', async () => {
      const current = await getAllSystemConfig();
      return {
        definitions: SYSTEM_CONFIG_DEFS,
        values: current,
      };
    });

    // GET /api/admin/config/:key — single entry
    f.get('/api/admin/config/:key', async (request: FastifyRequest) => {
      const { key } = request.params as { key: string };
      const def = SYSTEM_CONFIG_DEFS.find(d => d.key === key);
      if (!def) return { error: 'Unknown config key' };
      return {
        key,
        definition: def,
        value: await getSystemConfig(key),
      };
    });

    // PUT /api/admin/config/:key — update single entry
    f.put('/api/admin/config/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      const { key } = request.params as { key: string };
      const body = request.body as { value: string };
      const def = SYSTEM_CONFIG_DEFS.find(d => d.key === key);
      if (!def) return reply.status(404).send({ error: 'Unknown config key' });

      // Validate type
      if (def.type === 'number') {
        const n = parseInt(body.value, 10);
        if (isNaN(n)) return reply.status(400).send({ error: 'Must be a number' });
        if (def.min !== undefined && n < def.min) return reply.status(400).send({ error: `Minimum is ${def.min}` });
        if (def.max !== undefined && n > def.max) return reply.status(400).send({ error: `Maximum is ${def.max}` });
      } else if (def.type === 'boolean') {
        if (!['true', 'false'].includes(body.value)) {
          return reply.status(400).send({ error: 'Must be "true" or "false"' });
        }
      }

      await setSystemConfig(key, body.value);
      return { success: true, key, value: body.value };
    });

    // PUT /api/admin/config — batch update
    f.put('/api/admin/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, string>;
      const errors: string[] = [];

      for (const [key, value] of Object.entries(body)) {
        const def = SYSTEM_CONFIG_DEFS.find(d => d.key === key);
        if (!def) { errors.push(`Unknown key: ${key}`); continue; }
        if (def.type === 'number') {
          const n = parseInt(value, 10);
          if (isNaN(n)) { errors.push(`${key}: must be a number`); continue; }
          if (def.min !== undefined && n < def.min) { errors.push(`${key}: min is ${def.min}`); continue; }
          if (def.max !== undefined && n > def.max) { errors.push(`${key}: max is ${def.max}`); continue; }
        } else if (def.type === 'boolean') {
          if (!['true', 'false'].includes(value)) { errors.push(`${key}: must be true or false`); continue; }
        }
        await setSystemConfig(key, value);
      }

      if (errors.length > 0) {
        return reply.status(400).send({ error: 'Some values invalid', errors });
      }
      return { success: true, updated: Object.keys(body).length };
    });
  });
}
