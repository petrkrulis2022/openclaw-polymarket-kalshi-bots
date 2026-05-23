import { useCallback, useEffect, useRef, useState } from "react";

export interface SportsOpenPosition {
  tokenId: string;
  label: string;
  entryAsk: number;
  size: number;
  orderId: string;
  boughtAtMs: number;
}

export interface SportsClosedTrade extends SportsOpenPosition {
  sellPrice: number;
  pnl: number;
  reason: "profit" | "stop-loss" | "timeout" | "game-over";
  closedAtMs: number;
}

export interface SportsMarketInfo {
  yesTokenId: string;
  noTokenId: string;
  question: string;
}

export interface SportsBotData {
  trades: SportsClosedTrade[];
  openPosition: SportsOpenPosition | null;
  totalPnl: number;
  gameOver: boolean;
  matchSlug: string;
  market: SportsMarketInfo | null;
  metrics: { equity: number; pnl: number; openPositions: number } | null;
}

const DEFAULT_BOT_ID = 8;

export function useSportsBot(botId: number = DEFAULT_BOT_ID) {
  const [data, setData] = useState<SportsBotData>({
    trades: [],
    openPosition: null,
    totalPnl: 0,
    gameOver: false,
    matchSlug: "",
    market: null,
    metrics: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [tradesRes, metricsRes] = await Promise.all([
        fetch(`/api/bot/${botId}/trades`),
        fetch(`/api/bot/${botId}/metrics`),
      ]);
      const t = tradesRes.ok ? await tradesRes.json() : {};
      const m = metricsRes.ok ? await metricsRes.json() : null;
      setData({
        trades: t.trades ?? [],
        openPosition: t.openPosition ?? null,
        totalPnl: Number(t.totalPnl) || 0,
        gameOver: Boolean(t.gameOver),
        matchSlug: t.matchSlug ?? "",
        market: t.market ?? null,
        metrics: m
          ? {
              equity: Number(m.equity),
              pnl: Number(m.pnl),
              openPositions: m.openPositions,
            }
          : null,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bot offline");
    } finally {
      setLoading(false);
    }
  }, [botId]);

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
