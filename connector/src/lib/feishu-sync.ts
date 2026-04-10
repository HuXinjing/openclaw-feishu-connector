/**
 * Feishu organization sync job — BFS traversal of departments, upsert users into
 * user_network_profile, preserving admin-set allowed_ips / allow_external fields.
 */
import axios, { type AxiosResponse } from 'axios';
import { upsertNetworkProfile, getNetworkProfile } from './network-acl.js';
import type { UserNetworkProfile } from '../types.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

// ============================================================
// Test-injection hook — replaces the HTTP layer for unit tests.
// Tests set feishuHttpClient = { get, post } before calling runFeishuSync.
// ============================================================

interface FeishuHttpClient {
  get: (url: string, params?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, body?: unknown) => Promise<unknown>;
}

export let feishuHttpClient: FeishuHttpClient = {
  get: async (url, params) =>
    ((await axios.get(url, { ...(params ? { params } : {}), baseURL: FEISHU_API_BASE, timeout: 30_000 })) as AxiosResponse).data,
  post: async (url, body) =>
    ((await axios.post(url, body, { baseURL: FEISHU_API_BASE, timeout: 30_000 })) as AxiosResponse).data,
};

// Module-level token — set after authentication, used by axios interceptor
let _tenantToken = '';

/**
 * Injects Authorization header into every outgoing request.
 * Must be called after getTenantAccessToken() populates _tenantToken.
 */
// Only register interceptor in non-test environments (tests mock axios entirely)
try {
  axios.interceptors?.request?.use((config) => {
    if (_tenantToken) {
      config.headers['Authorization'] = `Bearer ${_tenantToken}`;
    }
    return config;
  });
} catch {
  // Interceptor not available (e.g. in test mocks) — ignore
}

// ============================================================
// Config
// ============================================================

function getAppId(): string {
  const val = process.env.FEISHU_APP_ID;
  if (!val) throw new Error('FEISHU_APP_ID env var is required');
  return val;
}

function getAppSecret(): string {
  const val = process.env.FEISHU_APP_SECRET;
  if (!val) throw new Error('FEISHU_APP_SECRET env var is required');
  return val;
}

// ============================================================
// Rate-limit helper — retries 429 with exponential back-off
// ============================================================

async function withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    // Check for 429 status — works for both AxiosError (err.response?.status) and
    // plain errors that carry a response object (e.g. from test fakes).
    const status = axios.isAxiosError(err)
      ? err.response?.status
      : (err as { response?: { status?: number } }).response?.status;
    if (status === 429) {
      if (attempt >= 5) throw err; // max 5 retries
      const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
      await new Promise(res => setTimeout(res, delayMs));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

// ============================================================
// Auth
// ============================================================

/**
 * Fetch a new tenant_access_token from Feishu.
 */
async function getTenantAccessToken(): Promise<string> {
  const response = (await feishuHttpClient.post(
    `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
    { app_id: getAppId(), app_secret: getAppSecret() },
  )) as { code: number; msg: string; tenant_access_token: string; expire: number };

  if (response.code !== 0) {
    throw new Error(`Feishu auth failed: ${response.msg}`);
  }
  _tenantToken = response.tenant_access_token;
  return _tenantToken;
}

// ============================================================
// Types for Feishu API responses
// ============================================================

interface FeishuDepartment {
  department_id: string;
  name: string;
  parent_department_id?: string;
  /** "0" means the department has no child departments */
  has_child_department?: boolean;
}

interface FeishuDepartmentListResponse {
  code: number;
  msg: string;
  data: {
    department_list: FeishuDepartment[];
    has_more: boolean;
    page_token?: string;
  };
}

interface FeishuUser {
  open_id: string;
  name: string;
  en_name?: string;
  avatar?: { avatar_72?: string; avatar_240?: string; avatar_640?: string };
  department_ids?: string[];
  status?: { is_activated?: boolean };
}

interface FeishuUserListResponse {
  code: number;
  msg: string;
  data: {
    items: FeishuUser[];
    has_more: boolean;
    page_token?: string;
  };
}

// ============================================================
// Core sync logic
// ============================================================

/**
 * Upsert a single user into user_network_profile.
 * If the user already has an `updated_at` set (admin edited fields),
 * their `allowed_ips` and `allow_external` are PRESERVED and not overwritten.
 */
function upsertUser(
  user: FeishuUser,
  departmentId: string,
  departmentName: string | null,
  existing?: UserNetworkProfile | null,
): void {

  const now = Math.floor(Date.now() / 1000);

  const profile: UserNetworkProfile = {
    open_id: user.open_id,
    // Preserve admin-set fields on existing profiles
    allowed_ips: existing?.updated_at != null
      ? existing.allowed_ips
      : ['0.0.0.0/0'],
    allow_external: existing?.allow_external ?? true,
    department_id: departmentId,
    department_name: departmentName ?? user.department_ids?.[0] ?? null,
    user_name: user.name ?? user.en_name ?? null,
    avatar_url: user.avatar?.avatar_240 ?? user.avatar?.avatar_72 ?? null,
    synced_at: now,
    updated_at: existing?.updated_at ?? null,
    updated_by: existing?.updated_by ?? null,
  };

  upsertNetworkProfile(profile);
}

const MAX_DEPTH = 50;

/**
 * Sync a single department and all its children (depth-first traversal).
 * Fetch department metadata first (to discover child IDs), then recurse into
 * children before finally syncing users for this department.
 */
async function syncDepartment(
  departmentId: string,
  errors: string[],
  stats: { synced: number; created: number; updated: number },
  depth = 0,
  alreadyFetchedDepts?: FeishuDepartment[],
): Promise<void> {
  if (depth > MAX_DEPTH) {
    errors.push(`Department ${departmentId} exceeded max depth ${MAX_DEPTH}`);
    return;
  }
  // --- 1. Fetch department metadata (to get name and child IDs) ---
  let deptName: string | null = null;
  let childIds: string[] = [];

  try {
    let deptList: FeishuDepartment[] = [];

    if (alreadyFetchedDepts !== undefined) {
      // Use data passed from runFeishuSync probe (avoids duplicate API call)
      deptList = alreadyFetchedDepts;
    } else {
      const deptRes = (await withRetry(() =>
        feishuHttpClient.get('/contact/v3/departments', {
          department_id: departmentId,
          fetch_child: true,
          user_id_type: 'open_id',
        }),
      )) as FeishuDepartmentListResponse;

      if (deptRes.code !== 0) {
        errors.push(`Department ${departmentId} metadata error: ${deptRes.msg}`);
      } else {
        deptList = deptRes.data?.department_list ?? [];
      }
    }

    const dept = deptList.find(d => d.department_id === departmentId);
    if (dept) {
      deptName = dept.name;
    }

    // Child department IDs are those returned alongside (but not equal to) this dept.
    // This avoids re-processing the same department when it appears in a parent's response.
    childIds = deptList
      .filter(d => d.department_id !== departmentId)
      .map(d => d.department_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Department ${departmentId} fetch error: ${msg}`);
  }

  // --- 2. Recurse into children first (depth-first, so parent is processed before children) ---
  for (const childId of childIds) {
    await syncDepartment(childId, errors, stats, depth + 1);
  }

  // --- 3. Sync users belonging to this department (paginated) ---
  let pageToken: string | undefined;
  do {
    try {
      const usersRes = (await withRetry(() =>
        feishuHttpClient.get('/contact/v3/users', {
          department_id: departmentId,
          user_id_type: 'open_id',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
      )) as FeishuUserListResponse;

      if (usersRes.code !== 0) {
        errors.push(`Users in dept ${departmentId} error: ${usersRes.msg}`);
        break;
      }

      const items = usersRes.data?.items ?? [];
      for (const user of items) {
        // Skip deactivated/inactive users
        if (user.status?.is_activated === false) continue;

        const existing = await getNetworkProfile(user.open_id);
        upsertUser(user, departmentId, deptName, existing);
        stats.synced++;

        if (!existing) {
          stats.created++;
        } else {
          // Only count as "updated" if a Feishu-sourced field changed
          const nameChanged = (user.name ?? '') !== (existing.user_name ?? '');
          const deptChanged = departmentId !== (existing.department_id ?? '');
          if (nameChanged || deptChanged) {
            stats.updated++;
          }
        }
      }

      pageToken = usersRes.data?.page_token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Users page dept=${departmentId} page=${pageToken ?? 'first'}: ${msg}`);
      break; // exit pagination loop; continue to next sibling
    }
  } while (pageToken);
}

/**
 * Fetch all visible users (no department filter), used as fallback when
 * the app has no access to the department tree but can still list users.
 */
async function syncAllUsers(
  errors: string[],
  stats: { synced: number; created: number; updated: number },
  rootDeptId = '',
  rootDeptName: string | null = null,
): Promise<void> {
  let pageToken: string | undefined;
  do {
    try {
      const usersRes = (await withRetry(() =>
        feishuHttpClient.get('/contact/v3/users', {
          user_id_type: 'open_id',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
      )) as FeishuUserListResponse;

      if (usersRes.code !== 0) {
        errors.push(`syncAllUsers error: ${usersRes.msg}`);
        // If no next page, stop (caller may fall back to syncDepartment or retry).
        if (!usersRes.data?.page_token) {
          break;
        }
        pageToken = usersRes.data.page_token;
        continue;
      }

      const items = usersRes.data?.items ?? [];
      for (const user of items) {
        if (user.status?.is_activated === false) continue;
        const existing = await getNetworkProfile(user.open_id);
        upsertUser(user, rootDeptId, rootDeptName, existing);
        stats.synced++;
        if (!existing) {
          stats.created++;
        } else {
          const nameChanged = (user.name ?? '') !== (existing.user_name ?? '');
          if (nameChanged) stats.updated++;
        }
      }

      pageToken = usersRes.data?.page_token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`syncAllUsers page=${pageToken ?? 'first'}: ${msg}`);
      break;
    }
  } while (pageToken);
}

// ============================================================
// Public API
// ============================================================

/**
 * Run the full Feishu organization sync:
 * 1. Authenticate
 * 2. Probe root department for child departments
 *    - If children exist: BFS from root department
 *    - If no department tree accessible: fetch all visible users directly
 * 3. Upsert every user into user_network_profile
 * 4. Return sync statistics
 *
 * Partial failures are logged but do not abort the overall sync.
 */
export async function runFeishuSync(): Promise<{
  synced: number;
  created: number;
  updated: number;
  errors: string[];
}> {
  await getTenantAccessToken(); // validates credentials + ensures client is ready

  const errors: string[] = [];
  const stats = { synced: 0, created: 0, updated: 0 };

  // Probe root department once to determine sync strategy (pass result to syncDepartment)
  let fetchedRootDepts: FeishuDepartment[] = [];
  try {
    const deptRes = (await withRetry(() =>
      feishuHttpClient.get('/contact/v3/departments', {
        department_id: '0',
        fetch_child: true,
        user_id_type: 'open_id',
      }),
    )) as FeishuDepartmentListResponse;

    if (deptRes.code === 0) {
      fetchedRootDepts = deptRes.data?.department_list ?? [];
    }
  } catch {
    // Probe failed — continue; syncDepartment will handle its own errors
  }

  if (fetchedRootDepts.length > 0) {
    // Department tree is accessible.
    // Only use BFS if root has child departments; otherwise fall back to
    // syncAllUsers since the per-department users API may require dept-level
    // auth that is not available.
    const hasChildren = fetchedRootDepts.some(d => d.department_id !== '0');
    if (hasChildren) {
      await syncDepartment('0', errors, stats, 0, fetchedRootDepts);
    } else {
      const rootDept = fetchedRootDepts.find(d => d.department_id === '0');
      await syncAllUsers(errors, stats, '0', rootDept?.name ?? null);
    }
  } else {
    // No department tree — fall back to listing all visible users
    await syncAllUsers(errors, stats);
  }

  return { ...stats, errors };
}

// Named export so tests can import it directly
export { getTenantAccessToken };
