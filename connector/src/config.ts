/**
 * Hot-reloadable config service.
 * Reloads on SIGHUP signal.
 */
import { readFileSync } from 'fs';

export interface AppConfig {
  rateLimit: { max: number; timeWindow: string };
  dlq: { maxRetries: number; retryDelayMs: number };
  gateway: { healthCheckIntervalMs: number; startupTimeoutMs: number };
}

const DEFAULT_CONFIG: AppConfig = {
  rateLimit: { max: 100, timeWindow: '1 minute' },
  dlq: { maxRetries: 3, retryDelayMs: 5000 },
  gateway: { healthCheckIntervalMs: 30000, startupTimeoutMs: 60000 },
};

let currentConfig: AppConfig = { ...DEFAULT_CONFIG };
const configPath = process.env.CONFIG_FILE || './config.json';

export function loadConfig(): AppConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function reloadConfig(): void {
  const prev = { ...currentConfig };
  currentConfig = loadConfig();
  console.log('[Config] Hot-reloaded:', JSON.stringify({ prev, next: currentConfig }));
}

export function getConfig(): AppConfig {
  return currentConfig;
}

// SIGHUP triggers hot-reload
process.on('SIGHUP', reloadConfig);
