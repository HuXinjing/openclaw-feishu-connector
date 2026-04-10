/**
 * System runtime config — reads from env vars first, then SQLite overrides.
 * Allows hot-patching config via the admin UI without restart.
 */
import { sqliteGetConfig, sqliteGetAllConfig, sqliteSetConfig } from '../store/sqlite.js';
import { isSqliteEnabled, isMysqlEnabled } from '../store/sqlite.js';

export interface SystemConfigDef {
  key: string;
  label: string;
  labelZh: string;
  type: 'number' | 'boolean' | 'text' | 'select';
  default: string;
  description: string;
  descriptionZh: string;
  options?: { value: string; label: string }[]; // for select type
  unit?: string;          // e.g. "ms", "个"
  min?: number;
  max?: number;
  step?: number;
}

export const SYSTEM_CONFIG_DEFS: SystemConfigDef[] = [
  {
    key: 'POOL_SIZE',
    label: 'Pool Size',
    labelZh: '预热池大小',
    type: 'number',
    default: '2',
    description: 'Number of pre-warmed containers kept ready',
    descriptionZh: '预热容器池中保持就绪状态的容器数量',
    unit: '个',
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: 'AUTO_WARM_POOL',
    label: 'Auto Warm Pool',
    labelZh: '启动时自动预热',
    type: 'boolean',
    default: 'false',
    description: 'Pre-warm pool containers on startup',
    descriptionZh: '服务启动时自动预热容器池',
  },
  {
    key: 'CONTAINER_SLEEP_ENABLED',
    label: 'Container Sleep',
    labelZh: '容器休眠',
    type: 'boolean',
    default: 'true',
    description: 'Idle containers enter sleep mode instead of stopping',
    descriptionZh: '闲置容器进入休眠而非停止，以加快下次唤醒',
  },
  {
    key: 'CONTAINER_CHECK_INTERVAL',
    label: 'Container Check Interval',
    labelZh: '容器检查间隔',
    type: 'number',
    default: '300000',
    description: 'How often to check container status',
    descriptionZh: '定期检查容器状态的间隔时间',
    unit: 'ms',
    min: 60000,
    max: 3600000,
    step: 30000,
  },
  {
    key: 'CONTAINER_INACTIVE_TIMEOUT',
    label: 'Inactive Timeout',
    labelZh: '空闲超时',
    type: 'number',
    default: '3600000',
    description: 'Stop containers after this idle time (ms)',
    descriptionZh: '容器空闲多久后停止（毫秒）',
    unit: 'ms',
    min: 300000,
    max: 86400000,
    step: 60000,
  },
  {
    key: 'CONTAINER_SESSION_IDLE_BUFFER_MS',
    label: 'Idle Buffer',
    labelZh: '空闲缓冲时间',
    type: 'number',
    default: '600000',
    description: 'Extra idle time before sleep (ms)',
    descriptionZh: '容器进入休眠前的额外空闲等待时间',
    unit: 'ms',
    min: 0,
    max: 3600000,
    step: 60000,
  },
  {
    key: 'CONTAINER_CRON_LOOKAHEAD_MS',
    label: 'Cron Lookahead',
    labelZh: '定时任务前瞻',
    type: 'number',
    default: '43200000',
    description: 'How far ahead to wake containers for scheduled tasks (ms)',
    descriptionZh: '提前多长时间唤醒容器以处理定时任务',
    unit: 'ms',
    min: 300000,
    max: 86400000,
    step: 300000,
  },
  {
    key: 'DEFAULT_MODEL',
    label: 'Default Model',
    labelZh: '默认 AI 模型',
    type: 'text',
    default: 'MiniMax-M2.5',
    description: 'Default AI model for new users',
    descriptionZh: '新用户容器使用的默认 AI 模型',
  },
  {
    key: 'HEALTH_CHECK_INTERVAL_MS',
    label: 'Health Check Interval',
    labelZh: '健康检查间隔',
    type: 'number',
    default: '30000',
    description: 'How often to probe running containers (ms)',
    descriptionZh: '探测运行中容器健康状态的间隔',
    unit: 'ms',
    min: 5000,
    max: 300000,
    step: 5000,
  },
  {
    key: 'OFFBOARD_CLEANUP_INTERVAL_MS',
    label: 'Cleanup Interval',
    labelZh: '清理间隔',
    type: 'number',
    default: '86400000',
    description: 'How often to clean up offboarded user data (ms)',
    descriptionZh: '清理离岗用户数据的周期',
    unit: 'ms',
    min: 3600000,
    max: 604800000,
    step: 3600000,
  },
  {
    key: 'OPENCLAW_IMAGE',
    label: 'Container Image',
    labelZh: '容器镜像',
    type: 'text',
    default: 'openclaw/openclaw:latest',
    description: 'Docker image used for user containers',
    descriptionZh: '用户容器使用的 Docker 镜像',
  },
];

// Env defaults — read once at startup
const ENV_DEFAULTS: Record<string, string> = {
  POOL_SIZE: process.env.POOL_SIZE || '2',
  AUTO_WARM_POOL: process.env.AUTO_WARM_POOL || 'false',
  CONTAINER_SLEEP_ENABLED: process.env.CONTAINER_SLEEP_ENABLED || 'true',
  CONTAINER_CHECK_INTERVAL: process.env.CONTAINER_CHECK_INTERVAL || '300000',
  CONTAINER_INACTIVE_TIMEOUT: process.env.CONTAINER_INACTIVE_TIMEOUT || '3600000',
  CONTAINER_SESSION_IDLE_BUFFER_MS: process.env.CONTAINER_SESSION_IDLE_BUFFER_MS || '600000',
  CONTAINER_CRON_LOOKAHEAD_MS: process.env.CONTAINER_CRON_LOOKAHEAD_MS || '43200000',
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'MiniMax-M2.5',
  HEALTH_CHECK_INTERVAL_MS: process.env.HEALTH_CHECK_INTERVAL_MS || '30000',
  OFFBOARD_CLEANUP_INTERVAL_MS: process.env.OFFBOARD_CLEANUP_INTERVAL_MS || '86400000',
  OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest',
};

/**
 * Get a config value — MySQL override wins over env var.
 */
export async function getSystemConfig(key: string): Promise<string> {
  if (!isSqliteEnabled()) return ENV_DEFAULTS[key] ?? '';
  const dbValue = await sqliteGetConfig(key);
  if (dbValue !== null) return dbValue;
  return ENV_DEFAULTS[key] ?? '';
}

/**
 * Get all config entries as key→value, with MySQL overrides applied.
 */
export async function getAllSystemConfig(): Promise<Record<string, string>> {
  const result: Record<string, string> = { ...ENV_DEFAULTS };
  if (isSqliteEnabled()) {
    const dbRows = await sqliteGetAllConfig();
    for (const row of dbRows) {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Set a config value in MySQL (runtime override).
 */
export async function setSystemConfig(key: string, value: string, updatedBy = 'admin'): Promise<void> {
  if (!isSqliteEnabled()) return;
  await sqliteSetConfig(key, value, updatedBy);
}

/**
 * Resolve a config key to its effective runtime value (boolean/number/text).
 * Use this for consumers that need typed values.
 */
export async function resolveConfig(key: string, type: 'number' | 'boolean' | 'text'): Promise<number | boolean | string> {
  const val = await getSystemConfig(key);
  if (type === 'number') return parseInt(val, 10);
  if (type === 'boolean') return val === 'true';
  return val;
}
