/**
 * User Quota — ClawManager ops pattern.
 * Enforces per-user limits on containers, CPU, memory, and message rate.
 */
import { findUsersByPhase } from '../user-map.js';

export interface UserQuota {
  openId: string;
  maxContainers: number;       // default 3
  maxCpuCores: number;      // default 4 cores
  maxMemoryMB: number;        // default 4096 MB
  maxIdleMinutes: number;     // default 60 min, stop container after idle
  maxMessageRate: number;     // default 60 msg/min
}

export const DEFAULT_QUOTA: UserQuota = {
  openId: '',
  maxContainers: 3,
  maxCpuCores: 4,
  maxMemoryMB: 4096,
  maxIdleMinutes: 60,
  maxMessageRate: 60,
};

// Per-user quota overrides (in-memory, replace with DB in production)
const quotaOverrides = new Map<string, Partial<UserQuota>>();

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  current: { containerCount: number; cpuCores: number; memoryMB: number };
}

/**
 * Get effective quota for a user (override merged with defaults).
 */
export function getUserQuota(openId: string): UserQuota {
  const overrides = quotaOverrides.get(openId) || {};
  return { ...DEFAULT_QUOTA, openId, ...overrides };
}

/**
 * Check if a user can create more resources.
 */
export function checkUserQuota(
  openId: string,
  requestedCpu?: number,
  requestedMemoryMB?: number
): QuotaCheckResult {
  const quota = getUserQuota(openId);
  const activeUsers = findUsersByPhase('active').filter(u => u.spec.feishuOpenId === openId);

  const containerCount = activeUsers.length;
  if (containerCount >= quota.maxContainers) {
    return {
      allowed: false,
      reason: `Container limit reached: ${containerCount}/${quota.maxContainers}`,
      current: { containerCount, cpuCores: 0, memoryMB: 0 },
    };
  }

  if (requestedCpu && requestedCpu > quota.maxCpuCores) {
    return {
      allowed: false,
      reason: `CPU exceeds quota: ${requestedCpu} > ${quota.maxCpuCores} cores`,
      current: { containerCount, cpuCores: 0, memoryMB: 0 },
    };
  }

  if (requestedMemoryMB && requestedMemoryMB > quota.maxMemoryMB) {
    return {
      allowed: false,
      reason: `Memory exceeds quota: ${requestedMemoryMB}MB > ${quota.maxMemoryMB}MB`,
      current: { containerCount, cpuCores: 0, memoryMB: 0 },
    };
  }

  return {
    allowed: true,
    current: { containerCount, cpuCores: 0, memoryMB: 0 },
  };
}

/**
 * Update a user's quota override.
 */
export function setUserQuota(openId: string, overrides: Partial<UserQuota>): void {
  quotaOverrides.set(openId, { ...(quotaOverrides.get(openId) || {}), ...overrides });
}

/**
 * Get the message rate for a user (sliding window counter).
 */
const messageRateCounters = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 60_000; // 1 minute

export function checkMessageRateLimit(openId: string): { allowed: boolean; remaining: number } {
  const quota = getUserQuota(openId);
  const now = Date.now();
  const counter = messageRateCounters.get(openId);

  if (!counter || now - counter.windowStart > RATE_WINDOW_MS) {
    messageRateCounters.set(openId, { count: 1, windowStart: now });
    return { allowed: true, remaining: quota.maxMessageRate - 1 };
  }

  if (counter.count >= quota.maxMessageRate) {
    return { allowed: false, remaining: 0 };
  }

  counter.count++;
  return { allowed: true, remaining: quota.maxMessageRate - counter.count };
}
