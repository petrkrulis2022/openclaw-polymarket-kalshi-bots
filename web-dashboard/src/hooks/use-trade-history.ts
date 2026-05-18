import { useCallback, useEffect, useRef, useState } from "react";

export interface TradeRecord {
  id: number;
  bot_id: number;
  market_id: string | null;
  market_question: string;
  condition_id: string | null;
  token_id: string | null;
  outcome: string | null;
  shares: number;
  avg_price: number;
  settled_price: number;
  realized_pnl: number;
  opened_at: string | null;
  closed_at: string;
  status: string;
}

export interface TradeSummary {
  totalTrades: number;
  totalPnl: number;
  totalInvested: number;
  winRate: number;
  byBot: Record<number, { totalPnl: number; trades: number; winners: number }>;
}

export function useTradeHistory(botId?: number) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const botParam = botId != null ? `?botId=${botId}` : "";
      const [tradesRes, summaryRes] = await Promise.all([
        fetch(`/api/orchestrator/trades${botParam}`),
        fetch(`/api/orchestrator/trades/summary`),
      ]);

      if (tradesRes.ok) {
        const json = await tradesRes.json();
        setTrades(
          ((json.trades ?? []) as Record<string, unknown>[]).map((r) => ({
            id: Number(r["id"]),
            bot_id: Number(r["bot_id"]),
            market_id: r["market_id"] ? String(r["market_id"]) : null,
            market_question: String(r["market_question"] ?? ""),
            condition_id: r["condition_id"] ? String(r["condition_id"]) : null,
            token_id: r["token_id"] ? String(r["token_id"]) : null,
            outcome: r["outcome"] ? String(r["outcome"]) : null,
            shares: Number(r["shares"]),
            avg_price: Number(r["avg_price"]),
            settled_price: Number(r["settled_price"]),
            realized_pnl: Number(r["realized_pnl"]),
            opened_at: r["opened_at"] ? String(r["opened_at"]) : null,
            closed_at: String(r["closed_at"] ?? ""),
            status: String(r["status"] ?? "closed"),
          })),
        );
      }

      if (summaryRes.ok) {
        const s = await summaryRes.json();
        setSummary(s as TradeSummary);
      }

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trade history");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setLoading(true);
    fetch_();
    timerRef.current = setInterval(fetch_, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { trades, summary, loading, error, refresh: fetch_ };
}
