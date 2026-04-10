/**
 * Skill 管理系统 - 数据模型和存储
 */
import fs from 'fs/promises';
import path from 'path';

// Content-addressable skill cache: key = URL/path, value = { etag, content, cachedAt }
interface CachedSkill {
  etag: string;
  content: string;
  cachedAt: number;
}

const skillCache = new Map<string, CachedSkill>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a skill package with ETag-based caching.
 * If content hasn't changed (304 Not Modified), returns cached version.
 * Only re-fetches when ETag changes or cache expires.
 */
async function fetchSkillWithCache(url: string): Promise<string> {
  const cached = skillCache.get(url);
  const now = Date.now();

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    console.log(`[SkillCache] HIT: ${url}`);
    return cached.content;
  }

  console.log(`[SkillCache] MISS: ${url}, fetching...`);
  const headers: Record<string, string> = {};
  if (cached) {
    headers['If-None-Match'] = cached.etag;
  }

  try {
    const response = await fetch(url, { headers });
    if (response.status === 304 && cached) {
      // Content unchanged, update timestamp and return
      cached.cachedAt = now;
      skillCache.set(url, cached);
      return cached.content;
    }
    if (response.status !== 200) {
      throw new Error(`Failed to fetch skill: ${response.status} ${response.statusText}`);
    }

    const etag = response.headers.get('etag') || Date.now().toString();
    const content = await response.text();
    skillCache.set(url, { etag, content, cachedAt: now });
    return content;
  } catch (err) {
    // If we have a cached version and the fetch failed, return it anyway
    if (cached) {
      console.log(`[SkillCache] Fetch failed for ${url}, returning stale cache`);
      return cached.content;
    }
    throw err;
  }
}

/**
 * Clear the skill cache (useful for manual refresh).
 */
export function clearSkillCache(): void {
  skillCache.clear();
  console.log('[SkillCache] Cleared');
}

const SKILL_STORE_PATH = process.env.SKILL_STORE_PATH || './data/skills.json';

export interface SkillRequest {
  id: number;
  name: string;
  description: string;
  content: string;      // skill 文件内容
  type: 'skill' | 'proxy';  // skill=用户容器技能, proxy=Connector API 代理
  status: 'pending' | 'approved' | 'rejected';
  requester_open_id?: string;
  approver?: string;
  created_at: number;
  updated_at: number;
}

interface SkillStore {
  requests: SkillRequest[];
  approvedSkills: SkillRequest[];  // 已批准的 skills（用于广播）
  nextId: number;
}

let store: SkillStore = { requests: [], approvedSkills: [], nextId: 1 };
let initialized = false;

/**
 * 初始化 skill 存储
 */
export async function initSkillStore(): Promise<void> {
  if (initialized) return;

  try {
    const data = await fs.readFile(SKILL_STORE_PATH, 'utf-8');
    store = JSON.parse(data);
  } catch {
    store = { requests: [], approvedSkills: [], nextId: 1 };
  }
  initialized = true;
}

/**
 * 保存到文件
 */
async function save(): Promise<void> {
  const dir = path.dirname(SKILL_STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(SKILL_STORE_PATH, JSON.stringify(store, null, 2));
}

/**
 * 提交 skill 请求
 */
export async function submitSkillRequest(
  name: string,
  description: string,
  content: string,
  type: 'skill' | 'proxy' = 'skill',
  requesterOpenId?: string
): Promise<SkillRequest> {
  await initSkillStore();

  const request: SkillRequest = {
    id: store.nextId++,
    name,
    description,
    content,
    type,
    status: 'pending',
    requester_open_id: requesterOpenId,
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  store.requests.push(request);
  await save();
  return request;
}

/**
 * 获取所有 pending 的请求
 */
export function getPendingRequests(): SkillRequest[] {
  return store.requests.filter(r => r.status === 'pending');
}

/**
 * 获取所有请求
 */
export function getAllRequests(): SkillRequest[] {
  return [...store.requests].sort((a, b) => b.created_at - a.created_at);
}

/**
 * 批准 skill 请求
 */
export async function approveRequest(id: number, approver?: string): Promise<SkillRequest | null> {
  await initSkillStore();

  const request = store.requests.find(r => r.id === id);
  if (!request || request.status !== 'pending') {
    return null;
  }

  request.status = 'approved';
  request.approver = approver;
  request.updated_at = Date.now();

  // 添加到已批准列表
  store.approvedSkills.push({ ...request });
  await save();

  return request;
}

/**
 * 拒绝 skill 请求
 */
export async function rejectRequest(id: number, approver?: string): Promise<SkillRequest | null> {
  await initSkillStore();

  const request = store.requests.find(r => r.id === id);
  if (!request || request.status !== 'pending') {
    return null;
  }

  request.status = 'rejected';
  request.approver = approver;
  request.updated_at = Date.now();
  await save();

  return request;
}

/**
 * 获取已批准的 skills
 */
export function getApprovedSkills(): SkillRequest[] {
  return [...store.approvedSkills];
}

/**
 * 获取单个请求
 */
export function getRequest(id: number): SkillRequest | null {
  return store.requests.find(r => r.id === id) || null;
}

/**
 * 根据 requester_open_id 获取用户提交的所有请求
 */
export function getRequestsByUser(requesterOpenId: string): SkillRequest[] {
  return store.requests
    .filter(r => r.requester_open_id === requesterOpenId)
    .sort((a, b) => b.created_at - a.created_at);
}
