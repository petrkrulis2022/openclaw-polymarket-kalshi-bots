// Shared in-memory store for when Supabase is unavailable
export interface MetricRow {
  bot_id: number;
  equity: number;
  pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  volatility: number | null;
  max_drawdown: number | null;
  utilization: number | null;
  open_positions: number;
  recorded_at: string;
}

// Latest metric per bot (bot_id → row)
export const inMemoryMetrics = new Map<number, MetricRow>();
