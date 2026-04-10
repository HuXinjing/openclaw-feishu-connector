/**
 * Dead Letter Queue for failed message persistence and retry.
 * Uses the MySQL store (was SQLite, migrated to avoid WSL2 SIGABRT).
 */
import { getDb, isSqliteEnabled } from '../store/sqlite.js';

export interface DLQEntry {
  id: number;
  eventId: string;
  openId: string;
  message: string;
  error?: string;
  retryCount: number;
  createdAt: number;
  lastRetryAt?: number;
  resolvedAt?: number;
}

function rowToEntry(row: Record<string, unknown>): DLQEntry {
  return {
    id: row.id as number,
    eventId: row.event_id as string,
    openId: row.open_id as string,
    message: row.message as string,
    error: row.error as string | undefined,
    retryCount: row.retry_count as number,
    createdAt: row.created_at as number,
    lastRetryAt: row.last_retry_at as number | undefined,
    resolvedAt: row.resolved_at as number | undefined,
  };
}

export async function enqueueDLQ(eventId: string, openId: string, message: string, error?: string): Promise<void> {
  if (!isSqliteEnabled()) return;
  const pool = getDb();
  if (!pool) return;
  await pool.execute(
    `INSERT INTO dlq (event_id, open_id, message, error, created_at) VALUES (?, ?, ?, ?, ?)`,
    [eventId, openId, message, error ?? null, Date.now()]
  );
}

export async function getDLQ(limit = 50): Promise<DLQEntry[]> {
  if (!isSqliteEnabled()) return [];
  const pool = getDb();
  if (!pool) return [];
  const [rows] = await pool.query<any[]>(
    `SELECT * FROM dlq WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return rows.map(rowToEntry);
}

export async function retryDLQ(id: number): Promise<boolean> {
  if (!isSqliteEnabled()) return false;
  const pool = getDb();
  if (!pool) return false;
  const [rows] = await pool.query<any[]>(`SELECT * FROM dlq WHERE id=?`, [id]);
  if (!rows || rows.length === 0) return false;
  await pool.execute(
    `UPDATE dlq SET retry_count=retry_count+1, last_retry_at=? WHERE id=?`,
    [Date.now(), id]
  );
  return true;
}

export async function resolveDLQ(id: number): Promise<void> {
  if (!isSqliteEnabled()) return;
  const pool = getDb();
  if (!pool) return;
  await pool.execute(`UPDATE dlq SET resolved_at=? WHERE id=?`, [Date.now(), id]);
}

export async function getDLQStats(): Promise<{ total: number; pending: number; resolved: number }> {
  if (!isSqliteEnabled()) return { total: 0, pending: 0, resolved: 0 };
  const pool = getDb();
  if (!pool) return { total: 0, pending: 0, resolved: 0 };
  const [[totalRow], [pendingRow]] = await Promise.all([
    pool.query<any[]>(`SELECT COUNT(*) as c FROM dlq`),
    pool.query<any[]>(`SELECT COUNT(*) as c FROM dlq WHERE resolved_at IS NULL`),
  ]);
  const total = totalRow?.[0]?.c ?? 0;
  const pending = pendingRow?.[0]?.c ?? 0;
  return { total, pending, resolved: total - pending };
}
