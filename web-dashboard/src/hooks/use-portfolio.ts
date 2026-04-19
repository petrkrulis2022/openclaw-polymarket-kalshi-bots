import { useCallback, useEffect, useRef, useState } from "react";

export interface BotSummary {
  id: string;
  name: string;
  strategy: string;
  status: string;
  equity: number;
  pnl: number;
  allocationPct: number;
  utilization: number;
  openPositions: number;
}

export interface Portfolio {
  totalEquity: number;
  totalPnl: number;
  bots: BotSummary[];
}

export function usePortfolio() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/orchestrator/portfolio/summary");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const data: Portfolio = {
        totalEquity: parseFloat(raw.totalEquity) || 0,
        totalPnl: parseFloat(raw.totalPnl) || 0,
        bots: (raw.bots ?? []).map((b: Record<string, unknown>) => ({
          id: String(b.id),
          name: b.name,
          strategy: b.strategy ?? "",
          status: b.status ?? "idle",
          equity: parseFloat(b.equity as string) || 0,
          pnl: parseFloat(b.pnl as string) || 0,
          allocationPct: parseFloat(b.allocationPct as string) || 0,
          utilization:
            b.utilization != null ? parseFloat(b.utilization as string) : 0,
          openPositions: Number(b.openPositions) || 0,
        })),
      };
      setPortfolio(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Orchestrator offline");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    timerRef.current = setInterval(fetch_, 5_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { portfolio, loading, error, refresh: fetch_ };
}
