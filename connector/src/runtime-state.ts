/**
 * 用户运行时状态（仅在 Connector 进程内存中维护）
 * 用于辅助判断容器是否空闲，而不依赖进程名匹配。
 */

export interface UserRuntimeState {
  openId: string;
  activeSessionCount: number;
  lastSessionStartAt?: number;
  lastSessionEndAt?: number;
}

const runtimeStates = new Map<string, UserRuntimeState>();

export function markSessionStart(openId: string): void {
  const now = Date.now();
  const state = runtimeStates.get(openId) ?? {
    openId,
    activeSessionCount: 0,
  };
  state.activeSessionCount = Math.max(0, state.activeSessionCount) + 1;
  state.lastSessionStartAt = now;
  runtimeStates.set(openId, state);
}

export function markSessionEnd(openId: string): void {
  const now = Date.now();
  const state = runtimeStates.get(openId) ?? {
    openId,
    activeSessionCount: 0,
  };
  state.activeSessionCount = Math.max(0, state.activeSessionCount - 1);
  state.lastSessionEndAt = now;
  runtimeStates.set(openId, state);
}

export function getUserRuntimeState(openId: string): UserRuntimeState | undefined {
  return runtimeStates.get(openId);
}

