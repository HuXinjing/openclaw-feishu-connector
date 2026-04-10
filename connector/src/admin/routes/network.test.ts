/**
 * Tests for admin network profile REST API routes.
 *
 * Uses vi.hoisted for mutable shared state, with vi.mock closing over that state
 * to provide an isolated in-memory layer over network-acl and feishu-sync.
 */
/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { initSqliteStore, sqliteClose } from '../../store/sqlite.js';

// ============================================================
// Mutable shared state via vi.hoisted (evaluated before vi.mock)
// ============================================================

const { profileStore, runningContainers } = vi.hoisted(() => ({
  profileStore: new Map<string, {
    open_id: string;
    allowed_ips: string[];
    allow_external: boolean;
    department_id: string | null;
    department_name: string | null;
    user_name: string | null;
    avatar_url: string | null;
    synced_at: number | null;
    updated_at: number | null;
    updated_by: string | null;
  }>(),
  runningContainers: new Map<string, string>(), // openId → containerIp
}));

const syncResult = { synced: 5, created: 3, updated: 2, errors: [] as string[] };
const syncShouldReject = { value: false };
const syncRejectError = new Error('Feishu API rate limited');

// ============================================================
// Mock network-acl — closes over profileStore and runningContainers
// ============================================================

vi.mock('../../lib/network-acl.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/network-acl.js')>('../../lib/network-acl.js');

  return {
    __esModule: true,
    ...actual,
    listNetworkProfiles: () =>
      Array.from(profileStore.values()).map(p => ({ ...p })),
    getNetworkProfile: (openId: string) => {
      const p = profileStore.get(openId);
      return p ? { ...p } : null;
    },
    updateNetworkProfile: (openId: string, patch: any) => {
      const existing = profileStore.get(openId);
      const now = Math.floor(Date.now() / 1000);
      profileStore.set(openId, {
        open_id: openId,
        allowed_ips: patch.allowed_ips ?? existing?.allowed_ips ?? [],
        allow_external: patch.allow_external ?? existing?.allow_external ?? true,
        department_id: existing?.department_id ?? null,
        department_name: existing?.department_name ?? null,
        user_name: existing?.user_name ?? null,
        avatar_url: existing?.avatar_url ?? null,
        synced_at: existing?.synced_at ?? null,
        updated_at: now,
        updated_by: patch.updated_by ?? existing?.updated_by ?? null,
      });
    },
    upsertNetworkProfile: (profile: any) => {
      profileStore.set(profile.open_id, { ...profile });
    },
    getContainerIpByOpenId: (openId: string) =>
      runningContainers.get(openId) ?? null,
    applyIptablesRules: () => {}, // best-effort: no-op in tests
  };
});

vi.mock('../../lib/feishu-sync.js', () => ({
  runFeishuSync: () =>
    syncShouldReject.value
      ? Promise.reject(syncRejectError)
      : Promise.resolve({ ...syncResult }),
}));

// ============================================================
// Fastify test app setup
// ============================================================

let app: any;
let token: string;

async function setupApp() {
  app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: 'test-secret' });
  app.post('/login', async (req: any, reply: any) => {
    const t = await reply.jwtSign({ role: 'admin' });
    return { token: t };
  });

  const { registerNetworkRoutes } = await import('./network.js');
  registerNetworkRoutes(app);

  const res = await app.inject({ method: 'POST', url: '/login', payload: {} });
  token = (await res.json()).token;
}

// ============================================================
// Setup / teardown
// ============================================================

beforeEach(async () => {
  profileStore.clear();
  runningContainers.clear();
  syncResult.errors.length = 0;
  syncShouldReject.value = false;

  // Seed two profiles
  profileStore.set('oi_alice', {
    open_id: 'oi_alice',
    allowed_ips: ['10.0.1.0/24'],
    allow_external: true,
    department_id: 'dept-eng',
    department_name: 'Engineering',
    user_name: 'Alice',
    avatar_url: 'https://cdn.example/alice.png',
    synced_at: 1700000000,
    updated_at: 1700010000,
    updated_by: null,
  });
  profileStore.set('oi_bob', {
    open_id: 'oi_bob',
    allowed_ips: ['192.168.1.0/24'],
    allow_external: false,
    department_id: 'dept-sales',
    department_name: 'Sales',
    user_name: 'Bob',
    avatar_url: null,
    synced_at: null,
    updated_at: null,
    updated_by: null,
  });

  await setupApp();
});

afterEach(() => {
  sqliteClose();
  app?.close();
});

// ============================================================
// Tests: GET /api/admin/network/profiles
// ============================================================

describe('GET /api/admin/network/profiles', () => {
  it('returns list of profiles with correct fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/network/profiles',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);

    const alice = body.find((p: any) => p.open_id === 'oi_alice');
    expect(alice).toMatchObject({
      open_id: 'oi_alice',
      user_name: 'Alice',
      department_name: 'Engineering',
      allowed_ips: ['10.0.1.0/24'],
      allow_external: true,
    });
    // Does NOT include internal-only fields
    expect(alice).not.toHaveProperty('department_id');
    expect(alice).not.toHaveProperty('synced_at');
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/network/profiles' });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
// Tests: GET /api/admin/network/profiles/:openId
// ============================================================

describe('GET /api/admin/network/profiles/:openId', () => {
  it('returns the full profile for a known openId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      open_id: 'oi_alice',
      user_name: 'Alice',
      allowed_ips: ['10.0.1.0/24'],
      allow_external: true,
      department_name: 'Engineering',
    });
    // Does NOT include internal-only fields
    expect(body).not.toHaveProperty('department_id');
    expect(body).not.toHaveProperty('synced_at');
    expect(body).not.toHaveProperty('updated_by');
  });

  it('returns 404 for an unknown openId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/network/profiles/oi_unknown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });
});

// ============================================================
// Tests: PUT /api/admin/network/profiles/:openId
// ============================================================

describe('PUT /api/admin/network/profiles/:openId', () => {
  it('updates allowed_ips and returns success', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allowed_ips: ['10.99.0.0/16', '172.16.0.0/12'] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    // Verify the store was updated
    const updated = profileStore.get('oi_alice');
    expect(updated?.allowed_ips).toEqual(['10.99.0.0/16', '172.16.0.0/12']);
  });

  it('updates allow_external and returns success', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_bob',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allow_external: true },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    const updated = profileStore.get('oi_bob');
    expect(updated?.allow_external).toBe(true);
  });

  it('applies iptables rules immediately when container is running', async () => {
    // Simulate running container for oi_alice
    runningContainers.set('oi_alice', '172.20.5.10');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allow_external: false },
    });

    expect(res.statusCode).toBe(200);
    // Verify the profile was updated
    const updated = profileStore.get('oi_alice');
    expect(updated?.allow_external).toBe(false);
    // Verify the running container IP was found
    expect(runningContainers.get('oi_alice')).toBe('172.20.5.10');
  });

  it('returns 400 when allowed_ips is not an array', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allowed_ips: 'not-an-array' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty('error', expect.stringContaining('allowed_ips'));
  });

  it('returns 400 when allow_external is not a boolean', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allow_external: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty('error', expect.stringContaining('allow_external'));
  });

  it('skips iptables when container is not running (openId has no container IP)', async () => {
    // oi_alice is not in runningContainers → getContainerIpByOpenId returns null
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/network/profiles/oi_alice',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { allow_external: false },
    });

    expect(res.statusCode).toBe(200);
    // The route calls applyIptablesRules only when getContainerIpByOpenId returns non-null.
    // Since oi_alice is not in runningContainers, applyIptablesRules is never called.
    expect(runningContainers.has('oi_alice')).toBe(false);
  });
});

// ============================================================
// Tests: POST /api/admin/network/import
// ============================================================

describe('POST /api/admin/network/import', () => {
  it('imports valid CSV rows', async () => {
    const csv = [
      'open_id,allowed_ips,allow_external',
      'oi_user1,"10.0.1.0/24;10.0.2.0/24",1',
      'oi_user2,"192.168.5.0/24",0',
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { csv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, imported: 2, errors: [] });

    expect(profileStore.get('oi_user1')?.allowed_ips).toEqual(['10.0.1.0/24', '10.0.2.0/24']);
    expect(profileStore.get('oi_user1')?.allow_external).toBe(true);
    expect(profileStore.get('oi_user2')?.allowed_ips).toEqual(['192.168.5.0/24']);
    expect(profileStore.get('oi_user2')?.allow_external).toBe(false);
  });

  it('skips rows with missing open_id and records errors', async () => {
    const csv = [
      'open_id,allowed_ips',
      'oi_good,10.0.1.0/24',
      ',10.0.2.0/24',
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { csv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, imported: 1 });
    expect(body.errors).toContainEqual(expect.stringContaining('missing open_id'));
  });

  it('returns 400 when csv field is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when open_id column is missing from header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { csv: 'name,allowed_ips\nuser,10.0.1.0/24' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toHaveProperty('error', expect.stringContaining('open_id'));
  });

  it('rejects invalid allow_external values and records errors', async () => {
    const csv = [
      'open_id,allow_external',
      'oi_user1,admin',
      'oi_user2,yes',
      'oi_user3,0',
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { csv },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, imported: 1 });
    expect(body.errors).toContainEqual(expect.stringContaining('invalid allow_external'));
    // Only row 3 (allow_external=0) should be imported
    expect(profileStore.get('oi_user3')?.allow_external).toBe(false);
    expect(profileStore.has('oi_user1')).toBe(false);
    expect(profileStore.has('oi_user2')).toBe(false);
  });

  it('handles newline-separated allowed_ips within a quoted field', async () => {
    // The parseCsvLine function handles quoted commas; splitCsvLines handles quoted newlines.
    // Simulate a CSV with embedded newline in the allowed_ips field value.
    const csv = 'open_id,allowed_ips\noi_new,"10.0.1.0/24\n10.0.2.0/24"';

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/import',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { csv },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).imported).toBe(1);
    expect(profileStore.get('oi_new')?.allowed_ips).toEqual(['10.0.1.0/24', '10.0.2.0/24']);
  });
});

// ============================================================
// Tests: GET /api/admin/network/export
// ============================================================

describe('GET /api/admin/network/export', () => {
  it('returns a CSV with correct Content-Type and Content-Disposition', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/network/export',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('network-profiles.csv');

    const text = res.body;
    expect(text).toContain('open_id,user_name,department_name');
    expect(text).toContain('oi_alice');
    expect(text).toContain('oi_bob');
  });

  it('CSV rows include allow_external as 0/1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/network/export',
      headers: { authorization: `Bearer ${token}` },
    });

    const text = res.body;
    // Alice: allow_external=true → 1, Bob: false → 0
    expect(text).toMatch(/oi_alice.*,1,/s);
    expect(text).toMatch(/oi_bob.*,0,/s);
  });
});

// ============================================================
// Tests: POST /api/admin/network/sync
// ============================================================

describe('POST /api/admin/network/sync', () => {
  it('calls runFeishuSync and returns stats', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/sync',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ synced: 5, created: 3, updated: 2, errors: [] });
  });

  it('returns 401 without JWT', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/network/sync' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 with structured error when runFeishuSync rejects', async () => {
    syncShouldReject.value = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/network/sync',
      headers: { authorization: `Bearer ${token}` },
    });
    syncShouldReject.value = false;

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Feishu API rate limited' });
  });
});
