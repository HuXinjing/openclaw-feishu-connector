/**
 * Tests for feishu-sync.ts.
 *
 * The module exports `feishuHttpClient` which is injected into the sync logic.
 * Tests control all HTTP responses by replacing this object before each test.
 */
/// <reference types="vitest/globals" />

import { beforeEach, afterEach, beforeAll } from 'vitest';

// ============================================================
// Mutable shared state — defined with vi.hoisted so it runs before
// vi.mock (which is hoisted to the top of the file)
// ============================================================

const { profileStore, isAxiosErrorReturn } = vi.hoisted(() => ({
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
  isAxiosErrorReturn: { value: false },
}));

// ============================================================
// Mock network-acl
// ============================================================

vi.mock('./network-acl.js', async () => {
  const actual = await vi.importActual<typeof import('./network-acl.js')>('./network-acl.js');

  return {
    ...actual,
    upsertNetworkProfile: vi.fn((profile: Parameters<typeof actual.upsertNetworkProfile>[0]) => {
      const existing = profileStore.get(profile.open_id);
      if (existing?.updated_at != null) {
        profileStore.set(profile.open_id, {
          ...profile,
          allowed_ips: existing.allowed_ips,
          allow_external: existing.allow_external,
        });
      } else {
        profileStore.set(profile.open_id, { ...profile });
      }
    }),
    getNetworkProfile: vi.fn((openId: string) => profileStore.get(openId) ?? null),
  };
});

// ============================================================
// Mock axios — only needs isAxiosError (for 429 detection in withRetry)
// ============================================================

vi.mock('axios', () => ({
  default: { isAxiosError: (err: unknown) => isAxiosErrorReturn.value },
}));

// ============================================================
// Import after mocks are set up
// ============================================================

import { initSqliteStore, sqliteClose } from '../store/sqlite.js';
import { runFeishuSync, feishuHttpClient } from './feishu-sync.js';

// ============================================================
// HTTP response helpers
// ============================================================

type HttpResponse = { code: number; msg?: string; data?: Record<string, unknown> };

function deptListResp(items: Array<{ department_id: string; name: string }>): HttpResponse {
  return { code: 0, data: { department_list: items, has_more: false } };
}

function usersResp(
  items: Array<{
    open_id: string;
    name: string;
    en_name?: string;
    avatar?: Record<string, string>;
    status?: { is_activated?: boolean };
    department_ids?: string[];
  }>,
  hasMore = false,
  pageToken?: string,
): HttpResponse {
  return {
    code: 0,
    data: {
      items: items.map(i => ({
        open_id: i.open_id,
        name: i.name,
        en_name: i.en_name,
        avatar: i.avatar,
        status: i.status,
        department_ids: i.department_ids,
      })),
      has_more: hasMore,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  };
}

function usersErrorResp(code: number, msg: string): HttpResponse {
  return { code, msg, data: { items: [], has_more: false } };
}

// Queue of HTTP responses consumed in order
const responseQueue: Array<{ resolved: boolean; value?: HttpResponse; rejectMsg?: string }> = [];

function pushResponse(resolved: boolean, value?: HttpResponse, rejectMsg?: string) {
  responseQueue.push({ resolved, value, rejectMsg });
}

function resetQueue() {
  responseQueue.length = 0;
}

// Inject fake HTTP client into the module
const fakeHttp = {
  async get(url: string, _params?: Record<string, unknown>): Promise<unknown> {
    const item = responseQueue.shift();
    if (!item) throw new Error(`Fake HTTP: unexpected GET ${url} — queue empty`);
    if (!item.resolved) {
      // Throw with a response.status so withRetry can detect 429 and retry.
      // withRetry checks (axios.isAxiosError ? err.response?.status : err.response?.status)
      const err = new Error(item.rejectMsg ?? 'request failed');
      (err as typeof err & { response: { status: number } }).response = { status: 429 };
      throw err;
    }
    return item.value;
  },
  // POST is always auth — never goes through the queue
  async post(_url: string, _body?: unknown): Promise<unknown> {
    return { code: 0, msg: 'ok', tenant_access_token: 'tok', expire: 7200 };
  },
};

function freshDb() {
  sqliteClose();
  return initSqliteStore(':memory:');
}

beforeAll(() => {
  process.env.FEISHU_APP_ID = 'test-app-id';
  process.env.FEISHU_APP_SECRET = 'test-app-secret';
  // Replace the HTTP client with our fake
  Object.assign(feishuHttpClient, fakeHttp);
});

beforeEach(() => {
  profileStore.clear();
  resetQueue();
  isAxiosErrorReturn.value = false;
  freshDb();
});

afterEach(() => {
  sqliteClose();
});

// ============================================================
// Tests
// ============================================================

describe('runFeishuSync — happy path', () => {
  it('syncs users from a single root department', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([
      { open_id: 'ou_u1', name: 'Alice', status: { is_activated: true } },
      { open_id: 'ou_u2', name: 'Bob', status: { is_activated: true } },
    ]));

    const result = await runFeishuSync();

    expect(result.synced).toBe(2);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const alice = profileStore.get('ou_u1')!;
    expect(alice.user_name).toBe('Alice');
    expect(alice.allowed_ips).toEqual(['0.0.0.0/0']);
    expect(alice.allow_external).toBe(true);
    expect(alice.department_id).toBe('0');
    expect(alice.department_name).toBe('Root');
  });

  it('syncs nested departments (parent before children)', async () => {
    // Root dept: returns root + child
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }, { department_id: 'dept-eng', name: 'Engineering' }]));
    // dept-eng metadata
    pushResponse(true, deptListResp([{ department_id: 'dept-eng', name: 'Engineering' }]));
    // dept-eng users
    pushResponse(true, usersResp([{ open_id: 'ou_eng_user', name: 'Alice Eng', status: {} }]));
    // Root users
    pushResponse(true, usersResp([{ open_id: 'ou_root_user', name: 'CEO', status: {} }]));

    const result = await runFeishuSync();

    expect(result.synced).toBe(2);
    expect(profileStore.get('ou_root_user')!.department_name).toBe('Root');
    expect(profileStore.get('ou_eng_user')!.department_name).toBe('Engineering');
  });

  it('skips deactivated users', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([
      { open_id: 'ou_active', name: 'Active', status: { is_activated: true } },
      { open_id: 'ou_inactive', name: 'Inactive', status: { is_activated: false } },
      { open_id: 'ou_nostatus', name: 'NoStatus', status: {} },
    ]));

    const result = await runFeishuSync();
    expect(result.synced).toBe(2);
    expect(profileStore.has('ou_inactive')).toBe(false);
    expect(profileStore.has('ou_active')).toBe(true);
    expect(profileStore.has('ou_nostatus')).toBe(true);
  });

  it('uses avatar_240 then avatar_72 from avatar object', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([
      {
        open_id: 'ou_av1',
        name: 'HasAll',
        avatar: { avatar_72: 'https://cdn/72.png', avatar_240: 'https://cdn/240.png' },
        status: {},
      },
      {
        open_id: 'ou_av2',
        name: 'Only72',
        avatar: { avatar_72: 'https://cdn/72.png' },
        status: {},
      },
    ]));

    await runFeishuSync();

    expect(profileStore.get('ou_av1')!.avatar_url).toBe('https://cdn/240.png');
    expect(profileStore.get('ou_av2')!.avatar_url).toBe('https://cdn/72.png');
  });
});

describe('runFeishuSync — pagination', () => {
  it('pages through users with page_token', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([{ open_id: 'ou_page1', name: 'User1', status: {} }], true, 'pg-abc'));
    pushResponse(true, usersResp([{ open_id: 'ou_page2', name: 'User2', status: {} }]));

    const result = await runFeishuSync();

    expect(result.synced).toBe(2);
    // 3 GET calls: dept metadata + page1 + page2
    expect(responseQueue).toHaveLength(0); // all consumed
  });
});

describe('runFeishuSync — preserve admin fields', () => {
  it('new users get default allowed_ips and allow_external', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([{ open_id: 'ou_new', name: 'NewUser', status: {} }]));

    await runFeishuSync();

    const p = profileStore.get('ou_new')!;
    expect(p.allowed_ips).toEqual(['0.0.0.0/0']);
    expect(p.allow_external).toBe(true);
  });

  it('existing user with updated_at set preserves allowed_ips and allow_external', async () => {
    // Pre-seed an admin-edited profile
    profileStore.set('ou_existing', {
      open_id: 'ou_existing',
      allowed_ips: ['10.99.0.0/16'],
      allow_external: false,
      department_id: 'old-dept',
      department_name: 'OldDept',
      user_name: 'ExistingUser',
      avatar_url: null,
      synced_at: 1000,
      updated_at: 2000,
      updated_by: 'admin@example.com',
    });

    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersResp([{ open_id: 'ou_existing', name: 'RenamedUser', status: {} }]));

    await runFeishuSync();

    const p = profileStore.get('ou_existing')!;
    expect(p.allowed_ips).toEqual(['10.99.0.0/16']);
    expect(p.allow_external).toBe(false);
    expect(p.user_name).toBe('RenamedUser'); // Feishu field updated
    expect(p.updated_at).toBe(2000); // admin field preserved
    expect(p.updated_by).toBe('admin@example.com');
  });
});

describe('runFeishuSync — error handling', () => {
  it('logs dept fetch error but continues sync', { timeout: 10000 }, async () => {
    // Probe dept succeeds (root only, no children) — syncAllUsers is used.
    // First users page returns a Feishu API error with a retry page_token.
    // syncAllUsers logs the error, continues to next page, and syncs the user.
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, { code: 99991663, msg: 'tenant access token rate limited',
      data: { items: [], has_more: true, page_token: 'retry' } });
    pushResponse(true, usersResp([{ open_id: 'ou_user1', name: 'U1', status: {} }]));

    const result = await runFeishuSync();

    // Users first page failed and was retried, second page succeeded
    expect(result.errors.some(e => e.includes('tenant access token rate limited'))).toBe(true);
    expect(result.synced).toBe(1);
  });

  it('logs user fetch error but continues to next department', async () => {
    // Root dept: root + dept-2
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }, { department_id: 'dept-2', name: 'Dept2' }]));
    // dept-2 metadata
    pushResponse(true, deptListResp([{ department_id: 'dept-2', name: 'Dept2' }]));
    // dept-2 users — succeeds
    pushResponse(true, usersResp([{ open_id: 'ou_d2user', name: 'D2User', status: {} }]));
    // Root users — Feishu API error (not network/429 — withRetry does not retry)
    pushResponse(true, usersErrorResp(10003, 'permission denied'));

    const result = await runFeishuSync();

    expect(result.errors.some(e => e.includes('permission denied'))).toBe(true);
    expect(result.synced).toBe(1);
    expect(profileStore.has('ou_d2user')).toBe(true);
  });

  it('logs non-zero Feishu error codes but continues sync', async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    pushResponse(true, usersErrorResp(10003, 'permission denied'));

    const result = await runFeishuSync();

    expect(result.errors.some(e => e.includes('permission denied'))).toBe(true);
  });
});

describe('runFeishuSync — rate limiting (429 retry)', () => {
  // 429 retry uses exponential back-off: 1s, 2s, 4s.  3 retries = 7s total.
  // Using a 30-second timeout for this test.
  it('retries 429 with exponential back-off then succeeds', { timeout: 30000 }, async () => {
    pushResponse(true, deptListResp([{ department_id: '0', name: 'Root' }]));
    // Users page: 429 × 3 retries → success
    pushResponse(false, undefined, 'rate limited');
    pushResponse(false, undefined, 'rate limited');
    pushResponse(false, undefined, 'rate limited');
    pushResponse(true, usersResp([{ open_id: 'ou_after_retry', name: 'AfterRetry', status: {} }]));

    // Enable 429 detection so withRetry recognizes the thrown errors
    isAxiosErrorReturn.value = true;
    try {
      const result = await runFeishuSync();
      expect(result.synced).toBe(1);
      expect(profileStore.has('ou_after_retry')).toBe(true);
    } finally {
      isAxiosErrorReturn.value = false;
    }
  });
});
