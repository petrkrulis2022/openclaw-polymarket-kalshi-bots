import { useCallback, useEffect, useRef, useState } from "react";

export interface MonitoringBotCard {
  botName: string;
  botId: number;
  status: "online" | "offline" | "stopped";
  equity: number | null;
  pnl: number | null;
  openPositions: number | null;
  lastActivityAt: string | null;
  extra: Record<string, unknown> | null;
  error: string | null;
}

export interface MonitoringData {
  fetchedAt: string | null;
  bots: MonitoringBotCard[];
}

const EMPTY: MonitoringData = { fetchedAt: null, bots: [] };

export function useMonitoring(metamaskAddress?: string) {
  const [data, setData] = useState<MonitoringData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!metamaskAddress) return;
    try {
      const res = await fetch(
        `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/monitoring`,
      );
      if (!res.ok) throw new Error(`Monitoring fetch failed: ${res.status}`);
      const json = (await res.json()) as MonitoringData;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Monitoring unavailable");
    } finally {
      setLoading(false);
    }
  }, [metamaskAddress]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 5_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}
