/**
 * Tests for network-acl.ts — IP allocation, profile CRUD, and iptables helpers.
 * SQLite tests use an in-memory DB. iptables rules are tested via spy/mock only.
 */
/// <reference types="vitest/globals" />

// Use vi.hoisted so the mock factory can share the calls array with test code.
const { calls: execSyncCalls, execSync: mockExecSync, exec: mockExec } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    execSync: ((cmd: unknown) => {
      calls.push(String(cmd));
      return Buffer.alloc(0);
    }) as typeof import('child_process').execSync,
    exec: ((() => ({ stdout: Buffer.alloc(0) })) as unknown) as typeof import('child_process').exec,
  };
});

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  exec: mockExec,
}));

import {
  allocateContainerIp,
  releaseContainerIp,
  getContainerIpByOpenId,
  getContainerIpByIp,
  getNetworkProfile,
  upsertNetworkProfile,
  listNetworkProfiles,
  updateNetworkProfile,
  applyIptablesRules,
  _testing_openIdToIp,
  _testing_ipToOpenId,
} from './network-acl.js';

// ----------------------------------------------------------------
// SQLite setup helpers — import getDb / initSqliteStore from sqlite.ts
// ----------------------------------------------------------------
import { initSqliteStore, getDb, sqliteClose } from '../store/sqlite.js';

// Use a fresh in-memory DB for every test suite
function freshDb() {
  sqliteClose();
  return initSqliteStore(':memory:');
}

// ----------------------------------------------------------------
// IP Allocation Tests
// ----------------------------------------------------------------

describe('IP Allocation', () => {
  beforeEach(() => {
    // Reset module state by re-importing would be ideal, but to avoid
    // complex re-import machinery we test with unique openIds per case.
    // Release any IPs we allocated so the pool doesn't truly exhaust.
  });

  it('allocates sequential IPs starting from 172.21.1.2', () => {
    const ip1 = allocateContainerIp('user-a');
    const ip2 = allocateContainerIp('user-b');
    const ip3 = allocateContainerIp('user-c');

    expect(ip1).toBe('172.21.1.2');
    expect(ip2).toBe('172.21.1.3');
    expect(ip3).toBe('172.21.1.4');

    // Clean up
    releaseContainerIp('user-a');
    releaseContainerIp('user-b');
    releaseContainerIp('user-c');
  });

  it('returns the same IP for the same openId (idempotent)', () => {
    const ip1 = allocateContainerIp('user-dup');
    const ip2 = allocateContainerIp('user-dup');
    expect(ip1).toBe(ip2);
    releaseContainerIp('user-dup');
  });

  it('releases an IP and allows it to be re-allocated', () => {
    const ip1 = allocateContainerIp('user-e');
    releaseContainerIp('user-e');
    const ip2 = allocateContainerIp('user-f');
    // ip2 should be the same as ip1 since ip1 was released
    expect(ip2).toBe(ip1);
  });

  it('getContainerIpByOpenId returns the correct IP', () => {
    const ip = allocateContainerIp('user-g');
    expect(getContainerIpByOpenId('user-g')).toBe(ip);
    expect(getContainerIpByOpenId('nonexistent')).toBeNull();
    releaseContainerIp('user-g');
  });

  it('getContainerIpByIp returns the correct openId', () => {
    const ip = allocateContainerIp('user-h');
    expect(getContainerIpByIp(ip)).toBe('user-h');
    expect(getContainerIpByIp('172.21.99.99')).toBeNull();
    releaseContainerIp('user-h');
  });

  it('throws when the IP pool is exhausted (mock-based)', async () => {
    // The real pool has ~65K IPs so we cannot exhaust it by iterating.
    // Instead, pre-fill all slots by directly populating the maps.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('./network-acl.js')) as any;

    // Save original maps
    const savedOpenIdToIp = new Map(mod._testing_openIdToIp);
    const savedIpToOpenId = new Map(mod._testing_ipToOpenId);

    try {
      mod._testing_openIdToIp.clear();
      mod._testing_ipToOpenId.clear();

      // Fill all 255 octets × 253 host slots = 64,515 entries
      for (let octet = 1; octet <= 255; octet++) {
        for (let host = 2; host <= 254; host++) {
          const ip = `172.21.${octet}.${host}`;
          const id = `fill-${octet}-${host}`;
          mod._testing_openIdToIp.set(id, ip);
          mod._testing_ipToOpenId.set(ip, id);
        }
      }

      // Next allocation must throw
      expect(() => mod.allocateContainerIp('exhaust-new-user')).toThrow(
        /pool exhausted/i
      );
    } finally {
      // Restore original maps
      mod._testing_openIdToIp.clear();
      mod._testing_ipToOpenId.clear();
      for (const [k, v] of savedOpenIdToIp) mod._testing_openIdToIp.set(k, v);
      for (const [k, v] of savedIpToOpenId) mod._testing_ipToOpenId.set(k, v);
    }
  });

  it('releaseContainerIp is a no-op for unknown openId', () => {
    expect(() => releaseContainerIp('never-allocated')).not.toThrow();
  });

  it('wraps octet and continues allocating when a /24 is full (mock-based)', async () => {
    // Allocate enough to fill octet.1 (253 IPs: .2-.254) then verify the
    // next IP is .2.2. We use a small pre-fill approach to avoid a slow loop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('./network-acl.js')) as any;

    const savedOpenIdToIp = new Map(mod._testing_openIdToIp);
    const savedIpToOpenId = new Map(mod._testing_ipToOpenId);

    try {
      mod._testing_openIdToIp.clear();
      mod._testing_ipToOpenId.clear();
      // Pre-fill octet.1
      for (let host = 2; host <= 254; host++) {
        const ip = `172.21.1.${host}`;
        mod._testing_openIdToIp.set(`prefill-${host}`, ip);
        mod._testing_ipToOpenId.set(ip, `prefill-${host}`);
      }

      const ipWrap = mod.allocateContainerIp('wrap-user');
      expect(ipWrap).toBe('172.21.2.2');
      mod.releaseContainerIp('wrap-user');
    } finally {
      mod._testing_openIdToIp.clear();
      mod._testing_ipToOpenId.clear();
      for (const [k, v] of savedOpenIdToIp) mod._testing_openIdToIp.set(k, v);
      for (const [k, v] of savedIpToOpenId) mod._testing_ipToOpenId.set(k, v);
    }
  });
});

// ----------------------------------------------------------------
// Profile CRUD Tests
// ----------------------------------------------------------------

describe('Profile CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  afterEach(() => {
    sqliteClose();
  });

  it('getNetworkProfile returns null for unknown openId', () => {
    expect(getNetworkProfile('unknown')).toBeNull();
  });

  it('upsertNetworkProfile inserts a new profile', () => {
    const profile: Parameters<typeof upsertNetworkProfile>[0] = {
      open_id: 'ou_abc123',
      allowed_ips: ['10.0.1.0/24', '10.0.3.50'],
      allow_external: true,
      department_id: 'dept-1',
      department_name: 'Engineering',
      user_name: 'Alice',
      avatar_url: 'https://example.com/avatar.png',
      synced_at: 1710000000,
      updated_at: null,
      updated_by: null,
    };

    upsertNetworkProfile(profile);
    const retrieved = getNetworkProfile('ou_abc123');

    expect(retrieved).not.toBeNull();
    expect(retrieved!.open_id).toBe('ou_abc123');
    expect(retrieved!.allowed_ips).toEqual(['10.0.1.0/24', '10.0.3.50']);
    expect(retrieved!.allow_external).toBe(true);
    expect(retrieved!.department_id).toBe('dept-1');
    expect(retrieved!.department_name).toBe('Engineering');
    expect(retrieved!.user_name).toBe('Alice');
  });

  it('upsertNetworkProfile overwrites an existing profile', () => {
    const p1: Parameters<typeof upsertNetworkProfile>[0] = {
      open_id: 'ou_def456',
      allowed_ips: ['10.0.0.0/8'],
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    };
    upsertNetworkProfile(p1);

    const p2: Parameters<typeof upsertNetworkProfile>[0] = {
      ...p1,
      allowed_ips: ['192.168.1.0/24'],
      allow_external: false,
      user_name: 'Bob',
    };
    upsertNetworkProfile(p2);

    const retrieved = getNetworkProfile('ou_def456')!;
    expect(retrieved.allowed_ips).toEqual(['192.168.1.0/24']);
    expect(retrieved.allow_external).toBe(false);
    expect(retrieved.user_name).toBe('Bob');
    // Original fields preserved
    expect(retrieved.department_id).toBeNull();
  });

  it('listNetworkProfiles returns all profiles', () => {
    upsertNetworkProfile({
      open_id: 'ou_list1',
      allowed_ips: ['10.0.0.0/8'],
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });
    upsertNetworkProfile({
      open_id: 'ou_list2',
      allowed_ips: ['192.168.0.0/16'],
      allow_external: false,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    const all = listNetworkProfiles();
    expect(all).toHaveLength(2);
    const ids = all.map(p => p.open_id).sort();
    expect(ids).toEqual(['ou_list1', 'ou_list2']);
  });

  it('updateNetworkProfile updates only provided fields', () => {
    upsertNetworkProfile({
      open_id: 'ou_update1',
      allowed_ips: ['10.0.0.0/8'],
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: 'Carol',
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    updateNetworkProfile('ou_update1', {
      allow_external: false,
      updated_by: 'admin@example.com',
    });

    const retrieved = getNetworkProfile('ou_update1')!;
    expect(retrieved.allow_external).toBe(false);
    expect(retrieved.allowed_ips).toEqual(['10.0.0.0/8']); // unchanged
    expect(retrieved.user_name).toBe('Carol');             // unchanged
    expect(retrieved.updated_by).toBe('admin@example.com');
    expect(retrieved.updated_at).not.toBeNull();
  });

  it('updateNetworkProfile creates profile if openId does not exist', () => {
    expect(getNetworkProfile('ou_newprofile')).toBeNull();

    updateNetworkProfile('ou_newprofile', {
      allowed_ips: ['10.0.0.0/8', '192.168.0.0/16'],
      allow_external: false,
      updated_by: 'setup',
    });

    const retrieved = getNetworkProfile('ou_newprofile')!;
    expect(retrieved.open_id).toBe('ou_newprofile');
    expect(retrieved.allowed_ips).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
    expect(retrieved.allow_external).toBe(false);
    expect(retrieved.updated_by).toBe('setup');
  });

  it('allowed_ips JSON round-trips correctly', () => {
    const original: string[] = [];
    upsertNetworkProfile({
      open_id: 'ou_json1',
      allowed_ips: original,
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });
    expect(getNetworkProfile('ou_json1')!.allowed_ips).toEqual([]);

    const withEntries = ['10.0.1.0/24', '192.168.1.50', '172.16.0.0/12'];
    upsertNetworkProfile({
      open_id: 'ou_json2',
      allowed_ips: withEntries,
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });
    expect(getNetworkProfile('ou_json2')!.allowed_ips).toEqual(withEntries);
  });

  it('null-handling: nullable fields are stored and retrieved correctly', () => {
    const profile: Parameters<typeof upsertNetworkProfile>[0] = {
      open_id: 'ou_nulls1',
      allowed_ips: [],
      allow_external: false,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    };
    upsertNetworkProfile(profile);
    const retrieved = getNetworkProfile('ou_nulls1')!;

    expect(retrieved.department_id).toBeNull();
    expect(retrieved.department_name).toBeNull();
    expect(retrieved.user_name).toBeNull();
    expect(retrieved.avatar_url).toBeNull();
    expect(retrieved.synced_at).toBeNull();
    expect(retrieved.updated_at).toBeNull();
    expect(retrieved.updated_by).toBeNull();
  });
});

// ----------------------------------------------------------------
// iptables Rules Tests (mocked execSync)
// ----------------------------------------------------------------

describe('applyIptablesRules — allowed_ips enforcement', () => {
  beforeEach(() => {
    freshDb();
    execSyncCalls.length = 0; // clear between tests
    // Register a container IP so getContainerIpByIp() returns an openId
    allocateContainerIp('ou_ipt_user');
  });

  afterEach(() => {
    releaseContainerIp('ou_ipt_user');
  });

  it('allowed_ips ["0.0.0.0/0"] generates ACCEPT rules for 10.0.0.0/8 and 192.168.0.0/16', () => {
    applyIptablesRules('172.21.1.2', {
      open_id: 'ou_ipt_user',
      allowed_ips: ['0.0.0.0/0'],
      allow_external: false,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    const cmds = execSyncCalls;
    expect(cmds.some(c => c.includes('-d 10.0.0.0/8') && c.includes('-j ACCEPT'))).toBe(true);
    expect(cmds.some(c => c.includes('-d 192.168.0.0/16') && c.includes('-j ACCEPT'))).toBe(true);
    // Should NOT have a generic per-entry rule for 0.0.0.0/0 itself
    expect(cmds.some(c => c.includes('-d 0.0.0.0/0'))).toBe(false);
    // Should have DNS accept rules (allow_external=false)
    expect(cmds.some(c => c.includes('--dport 53') && c.includes('-p udp'))).toBe(true);
    expect(cmds.some(c => c.includes('--dport 53') && c.includes('-p tcp'))).toBe(true);
    // Should have DROP rule
    expect(cmds.some(c => c.includes('-j DROP'))).toBe(true);
  });

  it('allowed_ips with specific CIDRs generates one ACCEPT rule per entry', () => {
    applyIptablesRules('172.21.1.3', {
      open_id: 'ou_ipt_user',
      allowed_ips: ['10.0.1.0/24', '10.0.3.50'],
      allow_external: false,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    const cmds = execSyncCalls;
    expect(cmds.some(c => c.includes('-d 10.0.1.0/24'))).toBe(true);
    expect(cmds.some(c => c.includes('-d 10.0.3.50'))).toBe(true);
    // Should NOT have hardcoded 10.0.0.0/8 rule when allowed_ips is specific
    expect(cmds.some(c => c.includes('-d 10.0.0.0/8'))).toBe(false);
    expect(cmds.some(c => c.includes('-d 192.168.0.0/16'))).toBe(false);
    // Should have DNS accept rules (allow_external=false)
    expect(cmds.some(c => c.includes('--dport 53') && c.includes('-p udp'))).toBe(true);
    expect(cmds.some(c => c.includes('--dport 53') && c.includes('-p tcp'))).toBe(true);
    // Should have DROP rule
    expect(cmds.some(c => c.includes('-j DROP'))).toBe(true);
  });

  it('allowed_ips ["0.0.0.0/0"] + allow_external=true adds external allow rule', () => {
    const ip = getContainerIpByOpenId('ou_ipt_user')!;
    applyIptablesRules(ip, {
      open_id: 'ou_ipt_user',
      allowed_ips: ['0.0.0.0/0'],
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    const cmds = execSyncCalls;
    // Should have the external allow rule (excludes internal subnets)
    expect(cmds.some(c => c.includes('! -d 10.0.0.0/8') && c.includes('! -d 192.168.0.0/16') && c.includes('-j ACCEPT'))).toBe(true);
    // Should NOT have DNS rules when allow_external=true
    expect(cmds.some(c => c.includes('--dport 53'))).toBe(false);
  });

  it('empty allowed_ips array produces no per-destination ACCEPT rules', () => {
    applyIptablesRules('172.21.1.5', {
      open_id: 'ou_ipt_user',
      allowed_ips: [],
      allow_external: false,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });

    const cmds = execSyncCalls;
    // No per-destination ACCEPT rules (no -d flag)
    const acceptCmds = cmds.filter(c => c.includes('-j ACCEPT'));
    // Only ESTABLISHED,RELATED and DNS rules should be ACCEPT; no destination-specific rules
    const destAcceptCmds = acceptCmds.filter(c => c.includes('-d '));
    expect(destAcceptCmds).toHaveLength(0);
  });

  it('warns and returns early if containerIp is not registered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execSyncCalls.length = 0; // clear before this specific test
    applyIptablesRules('172.21.99.99', {
      open_id: 'ou_unknown',
      allowed_ips: ['0.0.0.0/0'],
      allow_external: true,
      department_id: null,
      department_name: null,
      user_name: null,
      avatar_url: null,
      synced_at: null,
      updated_at: null,
      updated_by: null,
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(execSyncCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
