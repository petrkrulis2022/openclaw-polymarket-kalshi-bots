/**
 * hooks/use-bot-status.ts
 *
 * Polls the orchestrator for per-bot running/stopped status for the current
 * user and exposes startBot / stopBot helpers.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface BotStatus {
  name: string;
  pmName: string;
  status: string; // "online" | "stopped" | "errored" | ...
}

interface UseBotStatusReturn {
  bots: BotStatus[];
  loading: boolean;
  startBot: (botName: string) => Promise<void>;
  stopBot: (botName: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 10_000;

export function useBotStatus(
  metamaskAddress: string | undefined,
  _botsRunning: boolean,
): UseBotStatusReturn {
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    if (!metamaskAddress) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/status`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as BotStatus[];
      setBots(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [metamaskAddress]);

  useEffect(() => {
    if (!metamaskAddress) {
      setBots([]);
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    void fetch_();
    pollRef.current = setInterval(() => void fetch_(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [metamaskAddress, fetch_]);

  const startBot = useCallback(
    async (botName: string) => {
      if (!metamaskAddress) return;
      await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/start`,
        {
          method: "POST",
        },
      );
      await fetch_();
    },
    [metamaskAddress, fetch_],
  );

  const stopBot = useCallback(
    async (botName: string) => {
      if (!metamaskAddress) return;
      await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/stop`,
        {
          method: "POST",
        },
      );
      await fetch_();
    },
    [metamaskAddress, fetch_],
  );

  return { bots, loading, startBot, stopBot, refresh: fetch_ };
}
