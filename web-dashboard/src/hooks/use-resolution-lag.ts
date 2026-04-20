import { useCallback, useEffect, useRef, useState } from "react";

export type PositionStatus = "open" | "resolved" | "expired";

export interface LagPosition {
  id: string;
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  boughtAt: number;
  size: number;
  costBasis: number;
  expectedYield: number;
  orderId: string;
  status: PositionStatus;
  openedAt: string;
  resolvedAt?: string;
  realizedPnl?: number;
}

export interface ClosedMarket {
  id: string;
  question: string;
  gammaOutcome: "YES" | "NO" | "UNKNOWN";
  gammaResolved: boolean;
  clobResolved: boolean;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
}

export interface ResolutionOpportunity {
  market: ClosedMarket;
  winningTokenId: string;
  currentAsk: number;
  expectedYield: number;
}

export interface LagMetrics {
  equity: number;
  pnl: number;
  openPositions: number;
  utilization: number;
}

export interface ResolutionLagData {
  positions: LagPosition[];
  totalRealizedPnl: number;
  opportunities: ResolutionOpportunity[];
  scannedAt: string | null;
  metrics: LagMetrics | null;
}

const BASE = "/api/bot/5";

export function useResolutionLag() {
  const [data, setData] = useState<ResolutionLagData>({
    positions: [],
    totalRealizedPnl: 0,
    opportunities: [],
    scannedAt: null,
    metrics: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [posRes, oppRes, metRes] = await Promise.all([
        fetch(`${BASE}/positions`),
        fetch(`${BASE}/opportunities`),
        fetch(`${BASE}/metrics`),
      ]);
      const pos = posRes.ok ? await posRes.json() : {};
      const opp = oppRes.ok ? await oppRes.json() : {};
      const met = metRes.ok ? await metRes.json() : null;
      setData({
        positions: pos.positions ?? [],
        totalRealizedPnl: Number(pos.totalRealizedPnl) || 0,
        opportunities: opp.opportunities ?? [],
        scannedAt: opp.scannedAt ?? null,
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
