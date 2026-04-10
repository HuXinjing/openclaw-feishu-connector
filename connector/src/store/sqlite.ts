/**
 * MySQL-backed user store for planC production use.
 * Replaces better-sqlite3 with mysql2 to avoid native addon SIGABRT on WSL2.
 */
import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { FeishuUserRecord, FeishuUserSpec, FeishuUserPhase } from '../types.js';

let pool: Pool | null = null;

export function isMysqlEnabled(): boolean {
  return !!process.env.MYSQL_HOST;
}

/** Alias for backwards compat — checks MYSQL_HOST instead of USER_MAP_DB */
export function isSqliteEnabled(): boolean {
  return isMysqlEnabled();
}

export async function initSqliteStore(_dbPath?: string): Promise<void> {
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = parseInt(process.env.MYSQL_PORT || '3306');
  const user = process.env.MYSQL_USER || 'root';
  const password = process.env.MYSQL_PASSWORD;
  if (!password) {
    throw new Error('MYSQL_PASSWORD environment variable is required');
  }
  const database = process.env.MYSQL_DATABASE || 'feishu_connector';

  pool = mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 10 });

  // Helper: create index if not exists (MySQL doesn't support IF NOT EXISTS for indexes)
  async function createIndexSafe(sql: string): Promise<void> {
    try { await pool!.execute(sql); }
    catch (err: any) {
      // Ignore "Duplicate key name" errors — index already exists
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    }
  }

  // Create tables
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER AUTO_INCREMENT PRIMARY KEY,
      feishu_open_id VARCHAR(128) UNIQUE NOT NULL,
      spec JSON NOT NULL,
      status JSON NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_active BIGINT
    )
  `);
  await createIndexSafe(`CREATE INDEX idx_users_open_id ON users(feishu_open_id)`);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS dlq (
      id INTEGER AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(256) NOT NULL,
      open_id VARCHAR(128) NOT NULL,
      message TEXT NOT NULL,
      error TEXT,
      retry_count INT DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_retry_at BIGINT,
      resolved_at BIGINT
    )
  `);
  await createIndexSafe(`CREATE INDEX idx_dlq_open_id ON dlq(open_id)`);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS cost_records (
      id INTEGER AUTO_INCREMENT PRIMARY KEY,
      open_id VARCHAR(128) NOT NULL,
      model VARCHAR(64) NOT NULL,
      input_tokens INT,
      output_tokens INT,
      cost_usd DOUBLE,
      provider VARCHAR(64),
      created_at BIGINT NOT NULL
    )
  `);
  await createIndexSafe(`CREATE INDEX idx_cost_open_id ON cost_records(open_id)`);
  await createIndexSafe(`CREATE INDEX idx_cost_created_at ON cost_records(created_at)`);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_network_profile (
      open_id VARCHAR(128) PRIMARY KEY,
      allowed_ips JSON NOT NULL,
      allow_external TINYINT NOT NULL DEFAULT 1,
      department_id VARCHAR(128),
      department_name VARCHAR(256),
      user_name VARCHAR(256),
      avatar_url TEXT,
      synced_at BIGINT,
      updated_at BIGINT,
      updated_by VARCHAR(128)
    )
  `);
  await createIndexSafe(`CREATE INDEX idx_department ON user_network_profile(department_id)`);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS system_config (
      \`key\` VARCHAR(128) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      updated_by VARCHAR(128)
    )
  `);

  console.log('[Store] MySQL store initialized');
}

export async function initMysqlStore(): Promise<void> {
  await initSqliteStore();
}

export function getDb(): Pool | null {
  return pool;
}

export async function sqliteLoadAll(): Promise<FeishuUserRecord[]> {
  if (!pool) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, feishu_open_id, spec, status, created_at, updated_at, last_active FROM users'
  );
  return rows.map((row: any) => ({
    id: row.id,
    // MySQL JSON columns auto-parse; if already an object use it, otherwise parse string
    spec: typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec,
    status: typeof row.status === 'string' ? JSON.parse(row.status) : row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActive: row.last_active ?? undefined,
  }));
}

export async function sqliteInsertUser(record: FeishuUserRecord): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `INSERT INTO users (feishu_open_id, spec, status, created_at, updated_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.spec.feishuOpenId,
      JSON.stringify(record.spec),
      JSON.stringify(record.status),
      record.createdAt,
      record.updatedAt,
      record.lastActive ?? null,
    ]
  );
}

export async function sqliteUpdateStatus(openId: string, status: FeishuUserPhase, updatedAt: number): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `UPDATE users SET status=?, updated_at=? WHERE feishu_open_id=?`,
    [JSON.stringify(status), updatedAt, openId]
  );
}

export async function sqliteUpdateSpec(openId: string, spec: FeishuUserSpec, updatedAt: number): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `UPDATE users SET spec=?, updated_at=? WHERE feishu_open_id=?`,
    [JSON.stringify(spec), updatedAt, openId]
  );
}

export async function sqliteUpdateLastActive(openId: string, lastActive: number): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `UPDATE users SET last_active=?, updated_at=? WHERE feishu_open_id=?`,
    [lastActive, lastActive, openId]
  );
}

export async function sqliteDeleteUser(openId: string): Promise<void> {
  if (!pool) return;
  await pool.execute(`DELETE FROM users WHERE feishu_open_id=?`, [openId]);
}

export async function sqliteUpdateUserRecord(
  openId: string,
  spec: FeishuUserSpec,
  status: FeishuUserPhase,
  updatedAt: number,
  lastActive?: number
): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `UPDATE users SET spec=?, status=?, updated_at=?, last_active=? WHERE feishu_open_id=?`,
    [JSON.stringify(spec), JSON.stringify(status), updatedAt, lastActive ?? null, openId]
  );
}

export async function sqliteClose(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── System Config ───────────────────────────────────────────────────────

export interface SystemConfigEntry {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
}

export async function sqliteGetConfig(key: string): Promise<string | null> {
  if (!pool) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT value FROM system_config WHERE `key`=?',
    [key]
  );
  return rows.length > 0 ? (rows[0] as any).value : null;
}

export async function sqliteSetConfig(key: string, value: string, updatedBy = 'admin'): Promise<void> {
  if (!pool) return;
  await pool.execute(
    `INSERT INTO system_config (` + '`key`' + `, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value=?, updated_at=?, updated_by=?`,
    [key, value, Date.now(), updatedBy, value, Date.now(), updatedBy]
  );
}

export async function sqliteGetAllConfig(): Promise<SystemConfigEntry[]> {
  if (!pool) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT `key`, value, updated_at, updated_by FROM system_config ORDER BY `key`'
  );
  return rows as SystemConfigEntry[];
}
