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
      const data = (await res.json()) as Portfolio;
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
    timerRef.current = setInterval(fetch_, 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { portfolio, loading, error, refresh: fetch_ };
}
