/**
 * Network ACL — IP allocation, iptables rules, and profile CRUD for planC.
 * Enforces network isolation per user container via Docker bridge + iptables.
 */
import { execSync, exec } from 'child_process';
import type { UserNetworkProfile } from '../types.js';
import { getDb } from '../store/sqlite.js';

// ============================================================
// 1. IP Allocation
// ============================================================

// Subnet: 172.21.0.0/16
// Allocatable range: 172.21.1.2 – 172.21.255.254
const SUBNET_BASE = '172.21';
const IP_MIN_OCTET = 1;
const IP_MAX_OCTET = 255;
const IP_MIN_HOST = 2;
const IP_MAX_HOST = 254;

const openIdToIp = new Map<string, string>();
const ipToOpenId = new Map<string, string>();

// Exported for unit testing only — do not use outside tests
export const _testing_openIdToIp = openIdToIp;
export const _testing_ipToOpenId = ipToOpenId;

/**
 * Allocate a container IP for openId sequentially.
 * Throws if the pool is exhausted.
 */
export function allocateContainerIp(openId: string): string {
  if (openIdToIp.has(openId)) {
    return openIdToIp.get(openId)!;
  }

  for (let octet = IP_MIN_OCTET; octet <= IP_MAX_OCTET; octet++) {
    for (let host = IP_MIN_HOST; host <= IP_MAX_HOST; host++) {
      const ip = `${SUBNET_BASE}.${octet}.${host}`;
      if (!ipToOpenId.has(ip)) {
        openIdToIp.set(openId, ip);
        ipToOpenId.set(ip, openId);
        return ip;
      }
    }
  }

  throw new Error(
    `Container IP pool exhausted: no available IPs in 172.21.1.2–172.21.255.254`
  );
}

/**
 * Release the container IP associated with openId.
 * No-op if openId has no allocated IP.
 */
export function releaseContainerIp(openId: string): void {
  const ip = openIdToIp.get(openId);
  if (!ip) return;
  openIdToIp.delete(openId);
  ipToOpenId.delete(ip);
}

/**
 * Get the allocated container IP for a given openId.
 */
export function getContainerIpByOpenId(openId: string): string | null {
  return openIdToIp.get(openId) ?? null;
}

/**
 * Get the openId associated with a given container IP.
 */
export function getContainerIpByIp(ip: string): string | null {
  return ipToOpenId.get(ip) ?? null;
}

// ============================================================
// 2. iptables Rules
// ============================================================

/**
 * Apply iptables FORWARD rules for a container IP based on its network profile.
 * Rules are tagged with `--comment openclaw-{open_id}` for later removal.
 * Best-effort: logs a warning and continues on iptables failure.
 */
export function applyIptablesRules(containerIp: string, profile: UserNetworkProfile): void {
  const openId = getContainerIpByIp(containerIp);
  if (!openId) {
    console.warn(`[network-acl] Cannot apply iptables rules: no openId for IP ${containerIp}`);
    return;
  }
  const comment = `openclaw-${openId}`;

  const rules: string[][] = [
    // 1. ACCEPT established/related (return traffic)
    [
      '-A', 'FORWARD',
      '-s', containerIp,
      '-m', 'state', '--state', 'ESTABLISHED,RELATED',
      '-j', 'ACCEPT',
      '--comment', comment,
    ],
  ];

  // 2. ACCEPT rules derived from profile.allowed_ips
  // "0.0.0.0/0" means full internal access — use standard internal subnets as default policy.
  // Otherwise generate one ACCEPT rule per CIDR/IP entry.
  const allowedIpRules: string[][] =
    profile.allowed_ips.includes('0.0.0.0/0')
      ? [
          ['-A', 'FORWARD', '-s', containerIp, '-d', '10.0.0.0/8', '-j', 'ACCEPT', '--comment', comment],
          ['-A', 'FORWARD', '-s', containerIp, '-d', '192.168.0.0/16', '-j', 'ACCEPT', '--comment', comment],
        ]
      : profile.allowed_ips.map((ipOrCidr) => [
          '-A', 'FORWARD',
          '-s', containerIp,
          '-d', ipOrCidr,
          '-j', 'ACCEPT',
          '--comment', comment,
        ]);
  rules.push(...allowedIpRules);

  // 4. ACCEPT external if allow_external=true (not 10.0.0.0/8 or 192.168.0.0/16)
  if (profile.allow_external) {
    rules.push([
      '-A', 'FORWARD',
      '-s', containerIp,
      '!', '-d', '10.0.0.0/8',
      '!', '-d', '192.168.0.0/16',
      '-j', 'ACCEPT',
      '--comment', comment,
    ]);
  } else {
    // allow_external=false: still allow DNS (port 53) to any destination (RFC 1035: TCP and UDP)
    rules.push([
      '-A', 'FORWARD',
      '-s', containerIp,
      '-p', 'udp',
      '--dport', '53',
      '-j', 'ACCEPT',
      '--comment', comment,
    ]);
    rules.push([
      '-A', 'FORWARD',
      '-s', containerIp,
      '-p', 'tcp',
      '--dport', '53',
      '-j', 'ACCEPT',
      '--comment', comment,
    ]);
  }

  // 5. Default DROP for this container
  rules.push([
    '-A', 'FORWARD',
    '-s', containerIp,
    '-j', 'DROP',
    '--comment', comment,
  ]);

  for (const rule of rules) {
    try {
      const cmd = ['iptables', ...rule].join(' ');
      execSync(cmd, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`[network-acl] iptables rule failed (best-effort, continuing): ${err}`);
    }
  }
}

/**
 * Remove all iptables FORWARD rules tagged with `--comment openclaw-{open_id}`.
 * Best-effort: logs a warning and continues on iptables failure.
 */
export function removeIptablesRules(containerIp: string): void {
  const openId = getContainerIpByIp(containerIp);
  if (!openId) {
    console.warn(`[network-acl] Cannot remove iptables rules: no openId for IP ${containerIp}`);
    return;
  }
  const comment = `openclaw-${openId}`;

  // List current rules matching this comment
  let listed: string[];
  try {
    const out = execSync(`iptables -S FORWARD | grep "${comment}"`, { stdio: 'pipe' });
    listed = out.toString().trim().split('\n').filter(Boolean);
  } catch {
    // No matching rules — nothing to do
    return;
  }

  for (const ruleLine of listed) {
    try {
      // Convert listed rule (starts with "-A FORWARD ...") to delete form
      const parts = ruleLine.split(' ');
      // parts[0] is "-A", parts[1] is "FORWARD"
      const deleteParts = ['-D', 'FORWARD', ...parts.slice(2)];
      const cmd = ['iptables', ...deleteParts].join(' ');
      execSync(cmd, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`[network-acl] iptables delete failed (best-effort, continuing): ${err}`);
    }
  }
}

// ============================================================
// 3. Profile CRUD (SQLite)
// ============================================================

interface DbNetworkProfile {
  open_id: string;
  allowed_ips: string;
  allow_external: number;
  department_id: string | null;
  department_name: string | null;
  user_name: string | null;
  avatar_url: string | null;
  synced_at: number | null;
  updated_at: number | null;
  updated_by: string | null;
}

function rowToProfile(row: DbNetworkProfile): UserNetworkProfile {
  return {
    open_id: row.open_id,
    allowed_ips: typeof row.allowed_ips === 'string' ? JSON.parse(row.allowed_ips) : row.allowed_ips,
    allow_external: Boolean(row.allow_external),
    department_id: row.department_id ?? null,
    department_name: row.department_name ?? null,
    user_name: row.user_name ?? null,
    avatar_url: row.avatar_url ?? null,
    synced_at: row.synced_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

/**
 * Get a network profile by open_id. Returns null if not found.
 */
export async function getNetworkProfile(openId: string): Promise<UserNetworkProfile | null> {
  const pool = getDb();
  if (!pool) return null;
  const [rows] = await pool.query<any[]>(
    'SELECT * FROM user_network_profile WHERE open_id = ?',
    [openId]
  );
  return rows.length > 0 ? rowToProfile(rows[0]) : null;
}

/**
 * Insert or replace a network profile.
 */
export async function upsertNetworkProfile(profile: UserNetworkProfile): Promise<void> {
  const pool = getDb();
  if (!pool) return;
  await pool.execute(`
    INSERT INTO user_network_profile (
      open_id, allowed_ips, allow_external,
      department_id, department_name, user_name, avatar_url,
      synced_at, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      allowed_ips    = VALUES(allowed_ips),
      allow_external = VALUES(allow_external),
      department_id  = VALUES(department_id),
      department_name= VALUES(department_name),
      user_name      = VALUES(user_name),
      avatar_url     = VALUES(avatar_url),
      synced_at      = VALUES(synced_at),
      updated_at     = VALUES(updated_at),
      updated_by     = VALUES(updated_by)
  `, [
    profile.open_id,
    JSON.stringify(profile.allowed_ips),
    profile.allow_external ? 1 : 0,
    profile.department_id ?? null,
    profile.department_name ?? null,
    profile.user_name ?? null,
    profile.avatar_url ?? null,
    profile.synced_at ?? null,
    profile.updated_at ?? null,
    profile.updated_by ?? null,
  ]);
}

/**
 * List all network profiles.
 */
export async function listNetworkProfiles(): Promise<UserNetworkProfile[]> {
  const pool = getDb();
  if (!pool) return [];
  const [rows] = await pool.query<any[]>('SELECT * FROM user_network_profile');
  return rows.map(rowToProfile);
}

/**
 * Update allowed_ips and/or allow_external for a profile.
 */
export async function updateNetworkProfile(
  openId: string,
  patch: { allowed_ips?: string[]; allow_external?: boolean; updated_by?: string }
): Promise<void> {
  const existing = await getNetworkProfile(openId);
  if (!existing) {
    // Create a minimal profile with the patch fields
    const now = Math.floor(Date.now() / 1000);
    await upsertNetworkProfile({
      open_id: openId,
      allowed_ips: patch.allowed_ips ?? [],
      allow_external: patch.allow_external ?? true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: now,
      updated_by: patch.updated_by ?? null,
    });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await upsertNetworkProfile({
    ...existing,
    allowed_ips: patch.allowed_ips ?? existing.allowed_ips,
    allow_external: patch.allow_external ?? existing.allow_external,
    updated_at: now,
    updated_by: patch.updated_by ?? existing.updated_by,
  });
}

// ============================================================
// 4. Setup
// ============================================================

const OPENCLAW_NET = 'openclaw-net';
const OPENCLAW_SUBNET = '172.21.0.0/16';

/**
 * Create Docker network openclaw-net and insert a default DROP FORWARD rule
 * for all openclaw-net traffic. Idempotent — safe to call at startup.
 */
export function setupNetworkAcl(): void {
  // 1. Create Docker network if it doesn't exist
  try {
    execSync(`docker network create ${OPENCLAW_NET} --subnet=${OPENCLAW_SUBNET} --driver=bridge`, {
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Exit code 1 with "network with name openclaw-net already exists" is OK
    if (!msg.includes('already exists')) {
      console.warn(`[network-acl] docker network create failed (best-effort): ${msg}`);
    }
  }

  // 2. Ensure default DROP rule for openclaw-net FORWARD chain exists.
  //    Insert at position 1 so it catches unmatched packets before ACCEPT rules.
  //    Idempotent: skip if already present.
  const dropPattern = `FORWARD -d ${OPENCLAW_SUBNET} -j DROP`;
  try {
    const listed = execSync(`iptables -S FORWARD | grep "${dropPattern}"`, { stdio: 'pipe' });
    if (listed.toString().trim().length > 0) {
      // Already present
      return;
    }
  } catch {
    // Not found — insert it
  }

  try {
    execSync(
      `iptables -I FORWARD 1 -d ${OPENCLAW_SUBNET} -j DROP --comment "openclaw-net default drop"`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    console.warn(`[network-acl] iptables default DROP insert failed (best-effort): ${err}`);
  }
}
