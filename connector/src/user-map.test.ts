import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

const TEST_DB = '/tmp/planC-test-users.json';

describe('FeishuUserRecord operations', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.USER_MAP_DB = TEST_DB;
    const { resetUserMap } = await import('./user-map.js');
    resetUserMap();
  });

  it('should create user record with empty phase', async () => {
    const { initUserMap, createUserRecord } = await import('./user-map.js');
    await initUserMap();
    const record = await createUserRecord({
      feishuOpenId: 'ou_test123',
      hooksToken: 'test-token',
      permissions: ['dm:send', 'dm:receive'],
      poolStrategy: 'on-demand',
      channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false },
    });
    expect(record.spec.feishuOpenId).toBe('ou_test123');
    expect(record.status.phase).toBe('');
    expect(record.status.retryCount).toBe(0);
  });

  it('should update status phase without mutating spec', async () => {
    const { initUserMap, createUserRecord, updateUserStatus, findUserByOpenId } = await import('./user-map.js');
    await initUserMap();
    await createUserRecord({
      feishuOpenId: 'ou_test',
      hooksToken: 'test-token',
      permissions: [],
      poolStrategy: 'cold',
      channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false },
    });
    await updateUserStatus('ou_test', { phase: 'active', containerId: 'abc123', gatewayUrl: 'http://127.0.0.1:18799', gatewayAuthToken: 'tok', port: 18799 });
    const found = findUserByOpenId('ou_test');
    expect(found!.spec.feishuOpenId).toBe('ou_test'); // spec unchanged
    expect(found!.status.phase).toBe('active');
    expect(found!.status.containerId).toBe('abc123');
  });

  it('should update spec fields', async () => {
    const { initUserMap, createUserRecord, updateUserSpec, findUserByOpenId } = await import('./user-map.js');
    await initUserMap();
    await createUserRecord({ feishuOpenId: 'ou_spec', hooksToken: 'test-token', permissions: [], poolStrategy: 'cold', channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false } });
    await updateUserSpec('ou_spec', { feishuUserName: 'Test User', poolStrategy: 'warm' });
    const found = findUserByOpenId('ou_spec');
    expect(found!.spec.feishuUserName).toBe('Test User');
    expect(found!.spec.poolStrategy).toBe('warm');
  });

  it('should detect spec changes via lastSpec hash', async () => {
    const { hasSpecChanged, clearLastSpec } = await import('./user-map.js');
    const spec: import('./types.js').FeishuUserSpec = { feishuOpenId: 'ou_x', hooksToken: 'test-token', permissions: [], poolStrategy: 'on-demand', channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false } };
    expect(hasSpecChanged('ou_x', spec)).toBe(true);
    expect(hasSpecChanged('ou_x', spec)).toBe(false); // same spec, no change
    clearLastSpec('ou_x');
    expect(hasSpecChanged('ou_x', spec)).toBe(true); // cache cleared, new change
  });

  it('should find users by phase', async () => {
    const { initUserMap, createUserRecord, findUsersByPhase, updateUserStatus } = await import('./user-map.js');
    await initUserMap();
    await createUserRecord({ feishuOpenId: 'ou_a', hooksToken: 'test-token', permissions: [], poolStrategy: 'cold', channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false } });
    await createUserRecord({ feishuOpenId: 'ou_b', hooksToken: 'test-token', permissions: [], poolStrategy: 'cold', channelPolicy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], requireMention: false } });
    await updateUserStatus('ou_a', { phase: 'active' });
    const active = findUsersByPhase('active');
    expect(active.length).toBe(1);
    expect(active[0].spec.feishuOpenId).toBe('ou_a');
  });

  it('should return null for missing user', async () => {
    const { initUserMap, findUserByOpenId } = await import('./user-map.js');
    await initUserMap();
    expect(findUserByOpenId('ou_nonexistent')).toBeNull();
  });

  it('should return false for updating non-existent user', async () => {
    const { initUserMap, updateUserStatus } = await import('./user-map.js');
    await initUserMap();
    expect(await updateUserStatus('ou_nonexistent', { phase: 'active' })).toBe(false);
  });

  it('should return empty array for no users in phase', async () => {
    const { initUserMap, findUsersByPhase } = await import('./user-map.js');
    await initUserMap();
    expect(findUsersByPhase('active').length).toBe(0);
  });
});
