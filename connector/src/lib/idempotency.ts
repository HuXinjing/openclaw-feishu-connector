/**
 * Idempotency Key — ClawManager security pattern.
 * Deduplicates repeated requests within a TTL window to prevent double-processing.
 */
interface IdempotencyEntry {
  response: unknown;
  createdAt: number;
}

const cache = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a request with this idempotency key was already processed.
 * Returns the cached response if within TTL, null otherwise.
 */
export function checkIdempotency(key: string): IdempotencyEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

/**
 * Record the response for a given idempotency key.
 */
export function setIdempotency(key: string, response: unknown): void {
  cache.set(key, { response, createdAt: Date.now() });

  // Lazy cleanup when cache gets too large
  if (cache.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.createdAt > IDEMPOTENCY_TTL_MS) cache.delete(k);
    }
  }
}

/**
 * Build an idempotency key for a Feishu message event.
 */
export function buildMessageIdempotencyKey(openId: string, eventId: string): string {
  return `msg:${openId}:${eventId}`;
}

/**
 * Build an idempotency key for a heartbeat.
 */
export function buildHeartbeatIdempotencyKey(openId: string, tokenSuffix: string): string {
  return `hb:${openId}:${tokenSuffix}`;
}
