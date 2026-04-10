/**
 * 用户映射表 - JSON 文件 + SQLite 双存储
 * SQLite enabled when USER_MAP_DB ends with .db or USE_SQLITE_STORE=true.
 */
import fsSync from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { UserMapping, FeishuUserRecord, FeishuUserPhase, FeishuUserSpec } from './types.js';
import {
  isSqliteEnabled,
  initSqliteStore,
  sqliteLoadAll,
  sqliteInsertUser,
  sqliteUpdateStatus,
  sqliteUpdateSpec,
  sqliteUpdateLastActive,
  sqliteDeleteUser,
  sqliteUpdateUserRecord,
  sqliteClose,
} from './store/sqlite.js';

const DB_PATH = process.env.USER_MAP_DB || './data/users.json';

interface UserStore {
  users: FeishuUserRecord[];
  nextId: number;
}

let store: UserStore = { users: [], nextId: 1 };
let initialized = false;

// Spec-change hash cache: maps openId -> sha256 of last serialized spec
const lastSpecHash = new Map<string, string>();

function sha256(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/** Reset store for testing */
export async function resetUserMap(): Promise<void> {
  if (isSqliteEnabled()) await sqliteClose();
  store = { users: [], nextId: 1 };
  initialized = false;
}

/**
 * 初始化用户映射表 (从文件或 SQLite 加载)
 * Handles migration from legacy UserMapping[] to FeishuUserRecord[].
 */
export async function initUserMap(): Promise<void> {
  if (initialized) return;

  if (isSqliteEnabled()) {
    await initSqliteStore(DB_PATH);
    const records = await sqliteLoadAll();
    store = { users: records, nextId: records.length > 0 ? Math.max(...records.map(r => r.id)) + 1 : 1 };
    initialized = true;
    console.log(`[UserMap] Loaded ${records.length} users from MySQL`);
    return;
  }

  try {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    const parsed = JSON.parse(data);

    // Migration: legacy store uses flat UserMapping objects (has .open_id).
    // New store uses nested FeishuUserRecord objects (has .spec.feishuOpenId).
    if (Array.isArray(parsed.users) && parsed.users.length > 0) {
      const first = parsed.users[0];
      if ('open_id' in first && !('spec' in first)) {
        console.log('[UserMap] Migrating legacy UserMapping[] -> FeishuUserRecord[]');
        store = {
          nextId: parsed.nextId ?? 1,
          users: parsed.users.map((u: UserMapping) => ({
            id: u.id,
            spec: {
              feishuOpenId: u.open_id,
              userName: u.user_name,
              hooksToken: u.gateway_token,
            },
            status: {
              phase: u.status,
              gatewayUrl: u.gateway_url,
              gatewayAuthToken: u.gateway_auth_token,
              containerId: u.container_id,
              port: u.port,
            },
            createdAt: u.created_at,
            updatedAt: u.updated_at,
            lastActive: u.last_active,
          })),
        };
        save();
        initialized = true;
        return;
      }
    }

    store = parsed;
  } catch {
    // 文件不存在，使用空存储
    store = { users: [], nextId: 1 };
  }
  initialized = true;
}

/**
 * 保存到文件 (JSON mode; MySQL writes are done inline)
 */
async function save(): Promise<void> {
  if (isSqliteEnabled()) return;
  const dir = path.dirname(DB_PATH);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

/**
 * 生成 Gateway token
 * Token = sha256(open_id + salt) 的前 32 字符
 */
export function generateGatewayToken(openId: string, salt: string): string {
  return crypto
    .createHash('sha256')
    .update(openId + salt)
    .digest('hex')
    .substring(0, 32);
}

/**
 * 根据 open_id 查找用户 (FeishuUserRecord shape)
 */
export function findUserByOpenId(openId: string): FeishuUserRecord | null {
  return store.users.find(u => u.spec.feishuOpenId === openId) || null;
}

/**
 * 查找所有用户
 */
export function findAllUsers(): FeishuUserRecord[] {
  return [...store.users].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 查找状态为 active 的用户
 */
export function findActiveUsers(): FeishuUserRecord[] {
  return store.users
    .filter(u => u.status.phase === 'active')
    .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
}

/**
 * 查找所有状态为指定 phase 的用户
 */
export function findUsersByPhase(phase: FeishuUserPhase['phase']): FeishuUserRecord[] {
  return store.users.filter(u => u.status.phase === phase);
}

/**
 * 创建新用户
 */
export async function createUser(
  openId: string,
  gatewayUrl: string,
  gatewayToken: string,
  userName?: string,
  port?: number
): Promise<FeishuUserRecord> {
  const now = Date.now();
  const user: FeishuUserRecord = {
    id: store.nextId++,
    spec: {
      feishuOpenId: openId,
      userName,
      hooksToken: gatewayToken,
    },
    status: {
      phase: 'pending',
      gatewayUrl,
      port,
    },
    createdAt: now,
    updatedAt: now,
  };
  store.users.push(user);
  if (isSqliteEnabled()) await sqliteInsertUser(user);
  await save();
  return user;
}

/**
 * Async version — creates a user record and returns FeishuUserRecord.
 * Accepts either positional args (router.ts call sites) or a FeishuUserSpec-like
 * options object (test call sites).
 */
export async function createUserRecord(
  openIdOrSpec: string | Partial<FeishuUserSpec>,
  gatewayUrl?: string,
  gatewayToken?: string,
  userName?: string,
  port?: number
): Promise<FeishuUserRecord> {
  if (typeof openIdOrSpec === 'object') {
    // Options-object form: test call sites
    const spec = openIdOrSpec;
    const openId = spec.feishuOpenId!;
    const now = Date.now();
    const record: FeishuUserRecord = {
      id: store.nextId++,
      spec: {
        feishuOpenId: openId,
        userName: spec.userName,
        hooksToken: '',
        permissions: spec.permissions,
        poolStrategy: spec.poolStrategy,
        channelPolicy: spec.channelPolicy,
      },
      status: {
        phase: '',
        retryCount: 0,
      },
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(record);
    // Also register in lastSpecHash so hasSpecChanged returns false for first call
    lastSpecHash.set(openId, specHash(record.spec));
    if (isSqliteEnabled()) await sqliteInsertUser(record);
    await save();
    return record;
  }
  // Positional form: router.ts call sites
  const record = await createUser(openIdOrSpec, gatewayUrl!, gatewayToken!, userName, port);
  return record;
}

/**
 * 更新用户状态 (FeishuUserRecord internals, sync for backward compat).
 * Supports both positional args (original signature) and object patch form.
 * Returns true if user was found and updated.
 */
export async function updateUserStatus(
  openId: string,
  statusOrPatch: FeishuUserPhase['phase'] | Partial<FeishuUserPhase>,
  containerId?: string,
  gatewayAuthToken?: string,
  gatewayUrl?: string,
  port?: number
): Promise<boolean> {
  const user = store.users.find(u => u.spec.feishuOpenId === openId);
  if (!user) return false;

  // Object-patch form (test call sites)
  if (typeof statusOrPatch === 'object') {
    const patch = statusOrPatch;
    if (patch.phase !== undefined) user.status.phase = patch.phase;
    if (patch.containerId !== undefined) user.status.containerId = patch.containerId;
    if (patch.gatewayAuthToken !== undefined) user.status.gatewayAuthToken = patch.gatewayAuthToken;
    if (patch.gatewayUrl !== undefined) user.status.gatewayUrl = patch.gatewayUrl;
    if (patch.port !== undefined) user.status.port = patch.port;
    if (patch.retryCount !== undefined) user.status.retryCount = patch.retryCount;
    user.updatedAt = Date.now();
    if (isSqliteEnabled()) await sqliteUpdateStatus(openId, user.status, user.updatedAt);
    await save();
    return true;
  }

  // Positional form (original signature)
  const status = statusOrPatch;
  user.status.phase = status;
  user.updatedAt = Date.now();
  if (status === 'pooled') {
    user.status.containerId = undefined;
    user.status.gatewayUrl = '';
    user.status.gatewayAuthToken = undefined;
    user.status.port = undefined;
  } else {
    if (containerId !== undefined) user.status.containerId = containerId;
    if (gatewayAuthToken !== undefined) user.status.gatewayAuthToken = gatewayAuthToken;
    if (gatewayUrl !== undefined) user.status.gatewayUrl = gatewayUrl;
    if (port !== undefined) user.status.port = port;
  }
  if (isSqliteEnabled()) await sqliteUpdateStatus(openId, user.status, user.updatedAt);
  await save();
  return true;
}

/**
 * Async updateUserStatus using object form — preferred in router.ts Tasks 3-5.
 * Returns true if user was found and updated.
 */
export async function updateUserStatusRecord(
  openId: string,
  patch: Partial<FeishuUserPhase>
): Promise<boolean> {
  const user = store.users.find(u => u.spec.feishuOpenId === openId);
  if (!user) return false;
  if (patch.phase !== undefined) user.status.phase = patch.phase;
  if (patch.containerId !== undefined) user.status.containerId = patch.containerId;
  if (patch.gatewayAuthToken !== undefined) user.status.gatewayAuthToken = patch.gatewayAuthToken;
  if (patch.gatewayUrl !== undefined) user.status.gatewayUrl = patch.gatewayUrl;
  if (patch.port !== undefined) user.status.port = patch.port;
  user.updatedAt = Date.now();
  if (isSqliteEnabled()) await sqliteUpdateStatus(openId, user.status, user.updatedAt);
  await save();
  return true;
}

/**
 * Update user spec fields.
 */
export async function updateUserSpec(
  openId: string,
  patch: Partial<Pick<FeishuUserSpec, 'userName' | 'feishuUserName' | 'poolStrategy' | 'permissions' | 'channelPolicy'>>
): Promise<void> {
  const user = store.users.find(u => u.spec.feishuOpenId === openId);
  if (!user) return;
  if (patch.userName !== undefined) user.spec.userName = patch.userName;
  if (patch.feishuUserName !== undefined) user.spec.feishuUserName = patch.feishuUserName;
  if (patch.poolStrategy !== undefined) user.spec.poolStrategy = patch.poolStrategy;
  if (patch.permissions !== undefined) user.spec.permissions = patch.permissions;
  if (patch.channelPolicy !== undefined) user.spec.channelPolicy = patch.channelPolicy;
  user.updatedAt = Date.now();
  if (isSqliteEnabled()) await sqliteUpdateSpec(openId, user.spec, user.updatedAt);
  await save();
}

/**
 * Compute SHA256 hash of a spec object for change detection.
 */
function specHash(spec: FeishuUserSpec): string {
  return sha256(JSON.stringify(spec));
}

/**
 * Returns true if the spec differs from the last recorded hash for this user.
 */
export function hasSpecChanged(openId: string, newSpec: FeishuUserSpec): boolean {
  const lastHash = lastSpecHash.get(openId);
  const newHash = specHash(newSpec);
  if (lastHash !== newHash) {
    lastSpecHash.set(openId, newHash);
    return true;
  }
  return false;
}

/**
 * Clear the cached spec hash for a user (forces hasSpecChanged to return true next time).
 */
export function clearLastSpec(openId: string): void {
  lastSpecHash.delete(openId);
}

/**
 * 更新用户最后活跃时间
 */
export async function updateUserLastActive(openId: string): Promise<void> {
  const user = store.users.find(u => u.spec.feishuOpenId === openId);
  if (!user) return;

  user.lastActive = Date.now();
  user.updatedAt = Date.now();
  if (isSqliteEnabled()) await sqliteUpdateLastActive(openId, user.lastActive);
  await save();
}

/**
 * 更新用户信息
 */
export async function updateUser(openId: string, updates: Partial<Pick<FeishuUserRecord['spec'], 'userName'>> & Partial<Pick<FeishuUserRecord['status'], 'gatewayUrl' | 'containerId' | 'gatewayAuthToken'>>): Promise<void> {
  const user = store.users.find(u => u.spec.feishuOpenId === openId);
  if (!user) return;

  if (updates.userName !== undefined) user.spec.userName = updates.userName;
  if (updates.gatewayUrl !== undefined) user.status.gatewayUrl = updates.gatewayUrl;
  if (updates.containerId !== undefined) user.status.containerId = updates.containerId;
  if (updates.gatewayAuthToken !== undefined) user.status.gatewayAuthToken = updates.gatewayAuthToken;
  user.updatedAt = Date.now();
  if (isSqliteEnabled()) await sqliteUpdateUserRecord(openId, user.spec, user.status, user.updatedAt, user.lastActive);
  await save();
}

/**
 * 删除用户
 */
export async function deleteUser(openId: string): Promise<void> {
  const idx = store.users.findIndex(u => u.spec.feishuOpenId === openId);
  if (idx !== -1) {
    store.users.splice(idx, 1);
    if (isSqliteEnabled()) await sqliteDeleteUser(openId);
    await save();
  }
}

/**
 * 获取可用端口
 * 每个用户分配 10 个端口间隔，支持多 agent
 */
let currentPort = 18799;  // 从 18799 开始，预留一些端口
const PORT_STEP = 10;      // 每个用户间隔 10 个端口

export function getNextGatewayPort(): number {
  currentPort += PORT_STEP;
  return currentPort;
}

/**
 * 尝试复用用户的已有端口
 * 注意：目前禁用端口复用，始终返回 null 避免端口冲突问题
 */
export function getUserPort(openId: string): number | null {
  // 暂时禁用端口复用，始终分配新端口
  return null;
}
