/**
 * 用户级 user_access_token 存储（内存缓存 + AES-256-GCM 加密持久化）
 * 用于知识库搜索等需要 user 凭证的飞书 API；通过 OAuth 授权后按 open_id 存取。
 * 持久化使用 core/token-store.ts 的跨平台加密存储。
 */
import { storeUserToken, getUserToken, initTokenStore } from './core/token-store.js';

/** 内存缓存：openId -> token entry */
const cache = new Map<string, { access_token: string; expire_at: number }>();
let initialized = false;

const MARGIN_MS = 60_000; // 提前 1 分钟视为过期
const PROACTIVE_REFRESH_AHEAD_MS = 5 * 60 * 1000; // 提前 5 分钟主动刷新

interface TokenEntry {
  access_token: string;
  expire_at: number;
}

/** 初始化：从加密存储加载所有 token 到缓存（在 Connector 启动时调用） */
export async function initUserTokenStore(): Promise<void> {
  if (initialized) return;
  await initTokenStore();
  // Scan the encrypted store dir for all .uat files and load them
  // For now, we load lazily per-openId on first access
  initialized = true;
  console.log('[user-token-store] initialized');
}

/** 从加密存储同步单个 openId 到缓存 */
async function syncFromStore(openId: string): Promise<TokenEntry | null> {
  const tokenData = await getUserToken(openId);
  if (!tokenData) return null;
  try {
    const parsed = JSON.parse(tokenData) as { access_token: string; expire_at: number };
    if (!parsed.access_token || !parsed.expire_at) return null;
    const now = Date.now();
    if (parsed.expire_at < now - MARGIN_MS) return null;
    cache.set(openId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** 获取用户 access_token（优先缓存，支持主动刷新） */
export async function getUserAccessToken(openId: string): Promise<string | null> {
  if (!initialized) await initUserTokenStore();

  let entry = cache.get(openId);
  if (!entry) {
    entry = await syncFromStore(openId) ?? undefined;
  }
  if (!entry) return null;

  const now = Date.now();
  if (now >= entry.expire_at - MARGIN_MS) {
    // Token expired or about to expire
    return null;
  }

  // Proactive refresh: if expiring within 5 minutes, caller should refresh.
  // The flag is informational; actual refresh is done by the OAuth flow caller.
  if (now >= entry.expire_at - PROACTIVE_REFRESH_AHEAD_MS) {
    console.warn(`[user-token-store] token for ${openId} expires soon, proactive refresh recommended`);
  }

  return entry.access_token;
}

/** 存储用户 access_token（写入加密存储 + 缓存） */
export async function setUserAccessToken(
  openId: string,
  accessToken: string,
  expiresInSeconds: number
): Promise<void> {
  if (!initialized) await initUserTokenStore();

  const entry: TokenEntry = {
    access_token: accessToken,
    expire_at: Date.now() + expiresInSeconds * 1000,
  };

  // Update cache
  cache.set(openId, entry);

  // Persist to encrypted store
  await storeUserToken(openId, JSON.stringify(entry));
}

/** 检查是否存在有效 token（不包括即将过期的） */
export async function hasUserAccessToken(openId: string): Promise<boolean> {
  const token = await getUserAccessToken(openId);
  return token !== null;
}
