/**
 * CSV Bulk User Import (Task 13)
 */
import { parse } from 'csv-parse/sync';
import { findUserByOpenId, createUser, generateGatewayToken, getNextGatewayPort } from '../../user-map.js';
import { getUserGatewayUrl } from '../../docker.js';
import { resolveAuthContext } from '../../lib/ownership.js';
import { setUserQuota } from '../../lib/quota.js';

const HOOKS_TOKEN_SALT = process.env.HOOKS_TOKEN_SALT || 'default-salt-change-me';

export function registerImportRoutes(fastify: any) {
  fastify.post('/api/admin/users/import', async (request: any, reply: any) => {
    const ctx = resolveAuthContext(request);
    if (!ctx?.isAdmin) return reply.status(403).send({ error: 'Admin only' });

    const body = request.body as { csv: string };
    if (!body?.csv) return reply.status(400).send({ error: 'Missing csv field' });

    let records: Array<{ open_id: string; user_name?: string; quota_max_containers?: string }>;
    try {
      records = parse(body.csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Array<{ open_id: string; user_name?: string; quota_max_containers?: string }>;
    } catch (err) {
      return reply.status(400).send({ error: `CSV parse error: ${err instanceof Error ? err.message : String(err)}` });
    }

    const results = { created: 0, skipped: 0, errors: [] as string[] };

    for (const row of records) {
      if (!row.open_id) { results.errors.push('Missing open_id'); continue; }
      const existing = findUserByOpenId(row.open_id);
      if (existing) { results.skipped++; continue; }

      try {
        const gatewayToken = generateGatewayToken(row.open_id, HOOKS_TOKEN_SALT);
        const port = getNextGatewayPort();
        const gatewayUrl = getUserGatewayUrl(row.open_id, port);
        createUser(row.open_id, gatewayUrl, gatewayToken, row.user_name, port);
        if (row.quota_max_containers) {
          const maxContainers = parseInt(row.quota_max_containers, 10);
          if (!isNaN(maxContainers)) {
            setUserQuota(row.open_id, { maxContainers });
          }
        }
        results.created++;
      } catch (err) {
        results.errors.push(`Failed to create ${row.open_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results;
  });
}
