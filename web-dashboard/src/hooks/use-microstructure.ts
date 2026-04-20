import { useCallback, useEffect, useRef, useState } from "react";

export interface MicroPosition {
  marketId: string;
  marketQuestion: string;
  yesTokenId: string;
  endDate: string;
  daysToExpiry: number;
  bidOrderId: string | null;
  bidPrice: number;
  askOrderId: string | null;
  askPrice: number;
  heldShares: number;
  totalCost: number;
  totalRevenue: number;
  realizedPnl: number;
  lastUpdated: string;
}

export interface ScreenedMarket {
  id: string;
  question: string;
  yesTokenId: string;
  endDate: string;
  daysToExpiry: number;
  bestAsk: number;
}

export interface MicroMetrics {
  equity: number;
  pnl: number;
  openPositions: number;
  utilization: number;
}

export interface MicrostructureData {
  positions: MicroPosition[];
  totalRealizedPnl: number;
  screenedMarkets: ScreenedMarket[];
  metrics: MicroMetrics | null;
}

const BASE = "/api/bot/6";

export function useMicrostructure() {
  const [data, setData] = useState<MicrostructureData>({
    positions: [],
    totalRealizedPnl: 0,
    screenedMarkets: [],
    metrics: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [posRes, scrRes, metRes] = await Promise.all([
        fetch(`${BASE}/positions`),
        fetch(`${BASE}/screened-markets`),
        fetch(`${BASE}/metrics`),
      ]);
      const pos = posRes.ok ? await posRes.json() : {};
      const scr = scrRes.ok ? await scrRes.json() : [];
      const met = metRes.ok ? await metRes.json() : null;
      setData({
        positions: pos.positions ?? [],
        totalRealizedPnl: Number(pos.totalRealizedPnl) || 0,
        screenedMarkets: Array.isArray(scr) ? scr : [],
        metrics: met,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bot offline");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetch_();
    timerRef.current = setInterval(fetch_, 5_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { data, loading, error };
}
