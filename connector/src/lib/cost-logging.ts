/**
 * Per-User AI Cost Logging (Task 14)
 */
import { getDb, isSqliteEnabled } from '../store/sqlite.js';

export interface CostRecordParams {
  openId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface CostSummary {
  model: string;
  provider: string;
  total_input: number;
  total_output: number;
  total_cost: number;
}

/**
 * Record an AI API call for billing purposes.
 */
export async function recordAICall(params: CostRecordParams): Promise<void> {
  const pool = getDb();
  if (!pool) {
    console.warn('[CostLogging] MySQL not available, skipping cost record');
    return;
  }
  await pool.execute(
    `INSERT INTO cost_records
     (open_id, model, provider, input_tokens, output_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.openId,
      params.model,
      params.provider,
      params.inputTokens,
      params.outputTokens,
      params.costUSD,
      Date.now(),
    ]
  );
}

/**
 * Get per-model cost summary for a user within a time range.
 */
export async function getUserCostSummary(openId: string, fromMs: number, toMs: number): Promise<CostSummary[]> {
  const pool = getDb();
  if (!pool) return [];
  const [rows] = await pool.query<any[]>(`
    SELECT model, provider,
           SUM(input_tokens) as total_input,
           SUM(output_tokens) as total_output,
           SUM(cost_usd) as total_cost
    FROM cost_records
    WHERE open_id=? AND created_at>=? AND created_at<=?
    GROUP BY model, provider
  `, [openId, fromMs, toMs]);
  return rows as CostSummary[];
}
