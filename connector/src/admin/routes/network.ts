/**
 * Admin REST API routes for network profile management.
 */
import { requireAuth } from '../middleware.js';
import {
  listNetworkProfiles,
  getNetworkProfile,
  updateNetworkProfile,
  upsertNetworkProfile,
  getContainerIpByOpenId,
  applyIptablesRules,
} from '../../lib/network-acl.js';
import { runFeishuSync } from '../../lib/feishu-sync.js';
import type { UserNetworkProfile } from '../../types.js';

export function registerNetworkRoutes(fastify: any) {
  fastify.register(async (f: any) => {
    f.addHook('onRequest', requireAuth);

    // GET /api/admin/network/profiles — list all
    f.get('/api/admin/network/profiles', async () => {
      const profiles = await listNetworkProfiles();
      return profiles.map((p: UserNetworkProfile) => ({
        open_id: p.open_id,
        user_name: p.user_name,
        avatar_url: p.avatar_url,
        department_name: p.department_name,
        allowed_ips: p.allowed_ips,
        allow_external: p.allow_external,
        updated_at: p.updated_at,
      }));
    });

    // GET /api/admin/network/profiles/:openId — get single profile
    f.get('/api/admin/network/profiles/:openId', async (request: any, reply: any) => {
      const { openId } = request.params;
      const profile = await getNetworkProfile(openId);
      if (!profile) {
        return reply.status(404).send({ error: 'Profile not found' });
      }
      return {
        open_id: profile.open_id,
        user_name: profile.user_name,
        avatar_url: profile.avatar_url,
        department_name: profile.department_name,
        allowed_ips: profile.allowed_ips,
        allow_external: profile.allow_external,
        updated_at: profile.updated_at,
      };
    });

    // PUT /api/admin/network/profiles/:openId — update profile
    f.put('/api/admin/network/profiles/:openId', async (request: any, reply: any) => {
      const { openId } = request.params;
      const body = request.body as { allowed_ips?: string[]; allow_external?: boolean };

      if (body.allowed_ips !== undefined && !Array.isArray(body.allowed_ips)) {
        return reply.status(400).send({ error: 'allowed_ips must be an array of IP/CIDR strings' });
      }
      if (body.allow_external !== undefined && typeof body.allow_external !== 'boolean') {
        return reply.status(400).send({ error: 'allow_external must be a boolean' });
      }

      // Persist the update
      await updateNetworkProfile(openId, {
        allowed_ips: body.allowed_ips,
        allow_external: body.allow_external,
        updated_by: 'admin',
      });

      // If the container is running, apply new iptables rules immediately
      const containerIp = getContainerIpByOpenId(openId);
      if (containerIp) {
        const updatedProfile = await getNetworkProfile(openId);
        if (updatedProfile) {
          applyIptablesRules(containerIp, updatedProfile);
        }
      }

      return { success: true };
    });

    // POST /api/admin/network/import — CSV import
    f.post('/api/admin/network/import', async (request: any, reply: any) => {
      const body = request.body as { csv: string };
      if (!body?.csv) {
        return reply.status(400).send({ error: 'csv field is required' });
      }

      const lines = splitCsvLines(body.csv.trim());
      if (lines.length === 0) {
        return { success: true, imported: 0, errors: [] };
      }

      // First line is header
      const header = lines[0].trim().toLowerCase();
      const colOpenId = header.split(',').indexOf('open_id');
      if (colOpenId === -1) {
        return reply.status(400).send({ error: 'CSV must have an open_id column' });
      }

      const errors: string[] = [];
      let imported = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = parseCsvLine(line);
        const openId = cols[colOpenId];
        if (!openId) {
          errors.push(`Row ${i + 1}: missing open_id`);
          continue;
        }

        // allowed_ips column index (fall back to col 1 if only 2 cols)
        const colAllowedIps = header.split(',').indexOf('allowed_ips');
        const colAllowExternal = header.split(',').indexOf('allow_external');

        // Parse allowed_ips: ; or newline separated
        let allowedIps: string[] = [];
        if (colAllowedIps !== -1 && cols[colAllowedIps]) {
          const raw = cols[colAllowedIps].replace(/\n/g, ';');
          allowedIps = raw.split(';').map((s) => s.trim()).filter(Boolean);
        }

        // Parse allow_external: strict — only '1'/'true' → true, '0'/'false' → false, anything else → error
        let allowExternal: boolean | undefined = undefined;
        if (colAllowExternal !== -1 && cols[colAllowExternal] !== undefined) {
          const raw = cols[colAllowExternal];
          if (raw === '1' || raw === 'true') {
            allowExternal = true;
          } else if (raw === '0' || raw === 'false') {
            allowExternal = false;
          } else {
            errors.push(`Row ${i + 1}: invalid allow_external value "${raw}"`);
            continue;
          }
        }

        upsertNetworkProfile({
          open_id: openId,
          allowed_ips: allowedIps,
          allow_external: !!allowExternal,
          department_id: null,
          department_name: null,
          user_name: null,
          avatar_url: null,
          synced_at: null,
          updated_at: Math.floor(Date.now() / 1000),
          updated_by: 'admin',
        });
        imported++;
      }

      return { success: true, imported, errors };
    });

    // GET /api/admin/network/export — CSV export
    f.get('/api/admin/network/export', async (request: any, reply: any) => {
      const profiles = await listNetworkProfiles();
      const header = 'open_id,user_name,department_name,allowed_ips,allow_external,updated_at';
      const rows = profiles.map((p: UserNetworkProfile) => {
        const allowedIps = p.allowed_ips.join(';');
        const allowExternal = p.allow_external ? '1' : '0';
        const updatedAt = p.updated_at ? new Date(p.updated_at * 1000).toISOString() : '';
        // Quote fields that may contain commas or newlines
        const quote = (v: string | null | undefined) =>
          v != null && (v.includes(',') || v.includes('"') || v.includes('\n'))
            ? `"${v.replace(/"/g, '""')}"`
            : v ?? '';
        return [
          quote(p.open_id),
          quote(p.user_name),
          quote(p.department_name),
          `"${allowedIps}"`,
          allowExternal,
          quote(updatedAt),
        ].join(',');
      });

      const csv = [header, ...rows].join('\n');
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="network-profiles.csv"')
        .send(csv);
    });

    // POST /api/admin/network/sync — trigger Feishu sync
    f.post('/api/admin/network/sync', async (request: any, reply: any) => {
      try {
        const result = await runFeishuSync();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    });
  });
}

/**
 * Simple CSV line parser that handles double-quoted fields containing commas.
 * Does not handle all CSV edge cases — adequate for the import use case.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Split raw CSV text into lines, handling newlines inside quoted fields.
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
