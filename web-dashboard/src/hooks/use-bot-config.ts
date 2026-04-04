import { useState, useEffect, useCallback } from "react";

export interface QuotingParams {
  quoteHalfWidth: number;
  widthMultiplier: number;
  numMarkets: number;
  minVolume24h: number;
  pollIntervalMs: number;
  metricsIntervalMs: number;
  maxInventorySkew: number;
  reQuoteThreshold: number;
  orderStalenessThreshold: number;
  paperEquity: number;
}

export interface BotConfigState {
  params: QuotingParams | null;
  defaults: QuotingParams | null;
  paperTrading: boolean;
  loading: boolean;
  error: string | null;
  save: (patch: Partial<QuotingParams>) => Promise<QuotingParams | null>;
  reset: () => Promise<QuotingParams | null>;
  refresh: () => void;
}

export function useBotConfig(botId: number): BotConfigState {
  const [params, setParams] = useState<QuotingParams | null>(null);
  const [defaults, setDefaults] = useState<QuotingParams | null>(null);
  const [paperTrading, setPaperTrading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/bot/${botId}/config`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setParams(data.params ?? null);
        setDefaults(data.defaults ?? null);
        setPaperTrading(data.paperTrading ?? true);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, tick]);

  const save = useCallback(
    async (patch: Partial<QuotingParams>): Promise<QuotingParams | null> => {
      try {
        const r = await fetch(`/api/bot/${botId}/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error(`PUT /config failed: ${r.status}`);
        const data = await r.json();
        setParams(data.params);
        return data.params as QuotingParams;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [botId],
  );

  const reset = useCallback(async (): Promise<QuotingParams | null> => {
    try {
      const r = await fetch(`/api/bot/${botId}/config/reset`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(`POST /config/reset failed: ${r.status}`);
      const data = await r.json();
      setParams(data.params);
      return data.params as QuotingParams;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [botId]);

  return {
    params,
    defaults,
    paperTrading,
    loading,
    error,
    save,
    reset,
    refresh,
  };
}
