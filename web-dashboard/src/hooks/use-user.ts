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
  depositWalletAddress?: string;
  depositWalletPusd?: string;
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
  depositToPolymarket: () => Promise<{
    txHash: string;
    from: string;
    to: string;
    amount: string;
  }>;
  refresh: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const BALANCE_POLL_MS = 30_000; // poll bot wallet balance every 30 s

// Known Polygon contract addresses (no backend needed)
const POLYGON_RPC = "https://polygon-rpc.com";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

/**
 * Direct on-chain pUSD balanceOf call via eth_call JSON-RPC.
 * Works even when the treasury backend hasn't been restarted with the
 * new balance.ts code that returns depositWalletPusd.
 */
async function fetchPusdBalanceDirect(walletAddress: string): Promise<string> {
  // ERC20 balanceOf(address) selector = 0x70a08231, padded address
  const data =
    "0x70a08231" +
    walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: PUSD_ADDRESS, data }, "latest"],
  });
  const res = await fetch(POLYGON_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) return "0.000000";
  const json = (await res.json()) as { result?: string };
  if (!json.result || json.result === "0x") return "0.000000";
  const raw = BigInt(json.result);
  // pUSD has 6 decimals
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

/**
 * Compute deposit wallet address deterministically via the orchestrator.
 * Falls back gracefully if the endpoint doesn't exist yet.
 */
async function fetchDepositWalletAddress(
  metamaskAddress: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/orchestrator/users/${metamaskAddress}/deposit-wallet-address`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { depositWalletAddress?: string };
    return data.depositWalletAddress ?? null;
  } catch {
    return null;
  }
}

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

      // If treasury hasn't been restarted yet, depositWalletPusd will be missing.
      // Fall back to a direct on-chain eth_call so the UI always shows real pUSD.
      if (data.depositWalletPusd === undefined || data.depositWalletAddress === undefined) {
        const depositWalletAddress =
          data.depositWalletAddress ??
          (await fetchDepositWalletAddress(metamaskAddress));
        if (depositWalletAddress) {
          data.depositWalletAddress = depositWalletAddress;
          data.depositWalletPusd = await fetchPusdBalanceDirect(depositWalletAddress);
        }
      }

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

  const depositToPolymarket = useCallback(async () => {
    if (!metamaskAddress) throw new Error("Not connected");
    const res = await fetch(
      `/api/orchestrator/users/${metamaskAddress}/deposit-polymarket`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? "Deposit to Polymarket failed",
      );
    }
    const result = await res.json();
    await refreshBalance();
    return result as {
      txHash: string;
      from: string;
      to: string;
      amount: string;
    };
  }, [metamaskAddress, refreshBalance]);

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
    depositToPolymarket,
    refresh,
    refreshBalance,
  };
}
