import { useCallback, useEffect, useRef, useState } from "react";

export interface MarketPosition {
  conditionId: string;
  question: string;
  endDateIso: string;
  volume24hr: number;
  mid: number;
  spread: number;
  ourBidPrice: number;
  ourAskPrice: number;
  ourBidId: string | null;
  ourAskId: string | null;
  openPositions: number;
}

export interface InventoryPosition {
  tokenId: string;
  netSize: number;
  avgPrice: number;
  realizedPnl: number;
}

export interface BotDetail {
  markets: MarketPosition[];
  inventory: InventoryPosition[];
  totalRealizedPnl: number;
  allocatedEquity: number;
}

// Only Bot 1 (Market Maker) has a live /positions endpoint for now
const BOT_URLS: Record<number, string> = {
  1: "/api/bot/1",
};

export function useBotDetail(botId: number | null) {
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    if (botId === null) return;
    const baseUrl = BOT_URLS[botId];
    if (!baseUrl) {
      setDetail(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/positions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      setDetail({
        markets: raw.markets ?? [],
        inventory: raw.inventory ?? [],
        totalRealizedPnl: Number(raw.totalRealizedPnl) || 0,
        allocatedEquity: Number(raw.allocatedEquity) || 0,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bot offline");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    if (botId === null) {
      setDetail(null);
      setError(null);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    setLoading(true);
    fetch_();
    timerRef.current = setInterval(fetch_, 5_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [botId, fetch_]);

  return { detail, loading, error, refresh: fetch_ };
}
