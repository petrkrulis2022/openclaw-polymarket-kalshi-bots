/**
 * hooks/use-user.ts
 *
 * Manages the per-user registration state for multi-user support.
 * Automatically registers the connected MetaMask address with the orchestrator
 * and exposes helpers for saving API keys and starting bots.
 */

import { useState, useEffect, useCallback } from "react";

export interface UserRecord {
  metamaskAddress: string;
  botWalletAddress: string | null;
  hasApiKeys: boolean;
  botsRunning: boolean;
  createdAt: number;
}

interface UseUserReturn {
  user: UserRecord | null;
  loading: boolean;
  error: string | null;
  saveApiKeys: (
    apiKey: string,
    apiSecret: string,
    apiPassphrase: string,
  ) => Promise<void>;
  startBots: () => Promise<void>;
  stopBots: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useUser(metamaskAddress: string | undefined): UseUserReturn {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = useCallback(async (address: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/orchestrator/users/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metamaskAddress: address }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Registration failed",
        );
      }
      const data = (await res.json()) as UserRecord;
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!metamaskAddress) return;
    try {
      const res = await fetch(`/api/orchestrator/users/${metamaskAddress}`);
      if (!res.ok) return;
      const data = (await res.json()) as UserRecord;
      setUser(data);
    } catch {}
  }, [metamaskAddress]);

  useEffect(() => {
    if (!metamaskAddress) {
      setUser(null);
      setError(null);
      return;
    }
    register(metamaskAddress);
  }, [metamaskAddress, register]);

  const saveApiKeys = useCallback(
    async (apiKey: string, apiSecret: string, apiPassphrase: string) => {
      if (!metamaskAddress) return;
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/api-keys`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, apiSecret, apiPassphrase }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Failed to save API keys",
        );
      }
      await refresh();
    },
    [metamaskAddress, refresh],
  );

  const startBots = useCallback(async () => {
    if (!metamaskAddress) return;
    const res = await fetch(
      `/api/orchestrator/users/${metamaskAddress}/start-bots`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? "Failed to start bots",
      );
    }
    await refresh();
  }, [metamaskAddress, refresh]);

  const stopBots = useCallback(async () => {
    if (!metamaskAddress) return;
    const res = await fetch(
      `/api/orchestrator/users/${metamaskAddress}/stop-bots`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? "Failed to stop bots",
      );
    }
    await refresh();
  }, [metamaskAddress, refresh]);

  return { user, loading, error, saveApiKeys, startBots, stopBots, refresh };
}
