/**
 * hooks/use-user.ts
 *
 * Manages the per-user registration state for multi-user support.
 * Automatically registers the connected MetaMask address with the orchestrator
 * and exposes helpers for saving API keys, starting bots, converting funds, and
 * toggling autonomous mode.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface UserRecord {
  metamaskAddress: string;
  botWalletAddress: string | null;
  hasApiKeys: boolean; // true when funderAddress is set
  funderAddress: string | null;
  botsRunning: boolean;
  autonomousMode: boolean;
  createdAt: number;
}

export interface BotWalletBalance {
  address: string;
  usdt: string;
  usdce: string;
  nativePol: string;
}

interface UseUserReturn {
  user: UserRecord | null;
  loading: boolean;
  error: string | null;
  balance: BotWalletBalance | null;
  balanceLoading: boolean;
  saveFunderAddress: (funderAddress: string) => Promise<void>;
  startBots: () => Promise<void>;
  stopBots: () => Promise<void>;
  convertFunds: (
    amountUsdt?: string,
  ) => Promise<{ usdtSwapped: string; usdceReceived: string; txHash: string }>;
  setAutonomousMode: (enabled: boolean) => Promise<void>;
  withdrawFunds: (opts?: {
    amountUsdt?: string;
    stopBots?: boolean;
  }) => Promise<{
    swapTxHash?: string;
    usdceSwapped?: string;
    usdtReceived?: string;
    withdrawTxHash: string;
    amountWithdrawn: string;
    to: string;
  }>;
  refresh: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const BALANCE_POLL_MS = 30_000; // poll bot wallet balance every 30 s

export function useUser(metamaskAddress: string | undefined): UseUserReturn {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BotWalletBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const refreshBalance = useCallback(async () => {
    if (!metamaskAddress) return;
    setBalanceLoading(true);
    try {
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/balance`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as BotWalletBalance;
      setBalance(data);
    } catch {
    } finally {
      setBalanceLoading(false);
    }
  }, [metamaskAddress]);

  useEffect(() => {
    if (!metamaskAddress) {
      setUser(null);
      setError(null);
      setBalance(null);
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    register(metamaskAddress).then(() => refreshBalance());
    pollRef.current = setInterval(() => {
      refreshBalance();
    }, BALANCE_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [metamaskAddress, register, refreshBalance]);

  const saveFunderAddress = useCallback(
    async (funderAddress: string) => {
      if (!metamaskAddress) return;
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/funder-address`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funderAddress }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Failed to save funder address",
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

  const convertFunds = useCallback(
    async (amountUsdt?: string) => {
      if (!metamaskAddress) throw new Error("Not connected");
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/convert-funds`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(amountUsdt ? { amountUsdt } : {}),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Conversion failed",
        );
      }
      const result = (await res.json()) as {
        usdtSwapped: string;
        usdceReceived: string;
        txHash: string;
      };
      await refreshBalance();
      return result;
    },
    [metamaskAddress, refreshBalance],
  );

  const setAutonomousMode = useCallback(
    async (enabled: boolean) => {
      if (!metamaskAddress) return;
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/autonomous`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ??
            "Failed to update autonomous mode",
        );
      }
      await refresh();
    },
    [metamaskAddress, refresh],
  );

  const withdrawFunds = useCallback(
    async (opts?: { amountUsdt?: string; stopBots?: boolean }) => {
      if (!metamaskAddress) throw new Error("Not connected");
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/withdraw`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts ?? {}),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Withdrawal failed",
        );
      }
      const result = await res.json();
      await refreshBalance();
      return result;
    },
    [metamaskAddress, refreshBalance],
  );

  return {
    user,
    loading,
    error,
    balance,
    balanceLoading,
    saveFunderAddress,
    startBots,
    stopBots,
    convertFunds,
    setAutonomousMode,
    withdrawFunds,
    refresh,
    refreshBalance,
  };
}
