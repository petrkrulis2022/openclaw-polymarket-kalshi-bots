import { useCallback, useEffect, useRef, useState } from "react";

export type PairStatus = "pending" | "filled" | "partial" | "cancelled";

export interface ArbPair {
  id: string;
  marketId: string;
  marketQuestion: string;
  yesTokenId: string;
  noTokenId: string;
  yesOrderId: string;
  noOrderId: string;
  yesPrice: number;
  noPrice: number;
  sizeUsd: number;
  status: PairStatus;
  createdAt: string;
  settledAt?: string;
  realizedPnl?: number;
}

export interface ArbSignal {
  yesTokenId: string;
  noTokenId: string;
  marketId: string;
  marketQuestion: string;
  profitableVolumeUsd: number;
  yesEntryPrice: number;
  noEntryPrice: number;
  netSpread: number;
}

export interface ArbMetrics {
  equity: number;
  pnl: number;
  openPositions: number;
  utilization: number;
}

export interface InMarketArbData {
  pairs: ArbPair[];
  totalRealizedPnl: number;
  signals: ArbSignal[];
  scannedAt: string | null;
  metrics: ArbMetrics | null;
}

const BASE = "/api/bot/4";

export function useInMarketArb() {
  const [data, setData] = useState<InMarketArbData>({
    pairs: [],
    totalRealizedPnl: 0,
    signals: [],
    scannedAt: null,
    metrics: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [posRes, scanRes, metRes] = await Promise.all([
        fetch(`${BASE}/positions`),
        fetch(`${BASE}/scan-results`),
        fetch(`${BASE}/metrics`),
      ]);
      const pos = posRes.ok ? await posRes.json() : {};
      const scan = scanRes.ok ? await scanRes.json() : {};
      const met = metRes.ok ? await metRes.json() : null;
      setData({
        pairs: pos.pairs ?? [],
        totalRealizedPnl: Number(pos.totalRealizedPnl) || 0,
        signals: scan.signals ?? [],
        scannedAt: scan.scannedAt ?? null,
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
