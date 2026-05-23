import { useCallback, useEffect, useRef, useState } from "react";

const BOT_ROUTE_NAMES: Record<number, string> = {
  1: "market-maker",
  3: "copy-trader",
  4: "in-market-arb",
  5: "resolution-lag",
  6: "microstructure",
  10: "hockey-bot",
};

export interface BotDiagnostics {
  ok: boolean;
  bot: string;
  pmName: string;
  enabled: boolean;
  health?: string;
  healthy?: boolean;
  allocatedEquity?: number;
  lastTradeReconcileAt?: string | null;
  lastReconcileAt?: string | null;
  lastScanAt?: string | null;
  lastQuoteAt?: string | null;
  metrics?: Record<string, unknown> | null;
  reconciliation?: Record<string, unknown> | null;
  error?: string;
}

export function useBotDiagnostics(
  botId: number | null,
  metamaskAddress?: string,
) {
  const [data, setData] = useState<BotDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    if (!botId || !metamaskAddress) return;
    const botName = BOT_ROUTE_NAMES[botId];
    if (!botName) return;

    setLoading(true);
    try {
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/diagnostics`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BotDiagnostics);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bot offline");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [botId, metamaskAddress]);

  useEffect(() => {
    if (!botId || !metamaskAddress) {
      setData(null);
      setError(null);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    setLoading(true);
    void fetch_();
    timerRef.current = setInterval(() => void fetch_(), 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [botId, metamaskAddress, fetch_]);

  return { diagnostics: data, loading, error, refresh: fetch_ };
}
