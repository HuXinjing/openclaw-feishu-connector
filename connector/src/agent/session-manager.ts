/**
 * Agent session management — ClawManager pattern.
 * Handles 24h session token lifecycle with auto-refresh.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh 5min before expiry

/**
 * Returns true if the session should be refreshed.
 * Refreshes when less than REFRESH_THRESHOLD_MS remain.
 */
export function shouldRefreshSession(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false;
  return Date.now() + REFRESH_THRESHOLD_MS >= expiresAt;
}

/**
 * Generate a new 24h session token for the given openId.
 */
export function generateSessionToken(openId: string): string {
  return `agt_sess_${openId}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Refresh a session — generate new token and update expiresAt.
 * Caller is responsible for persisting the update.
 */
export function createRefreshedSession(): { token: string; expiresAt: number } {
  return {
    token: generateSessionToken(''), // openId is injected by caller
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

/**
 * Build a full refreshed session for a given openId.
 */
export function buildRefreshedSession(openId: string): { token: string; expiresAt: number } {
  return {
    token: generateSessionToken(openId),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}
