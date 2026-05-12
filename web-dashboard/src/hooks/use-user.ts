/**
 * hooks/use-user.ts
 *
 * Manages the per-user registration state for multi-user support.
 * Automatically registers the connected MetaMask address with the orchestrator
 * and exposes helpers for saving API keys, starting bots, converting funds, and
 * toggling autonomous mode.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  getCreate2Address,
  pad,
  concat,
  toBytes,
  toHex,
} from "viem";

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

// Polymarket deposit wallet factory constants (Polygon mainnet)
// Mirrors wdk-treasury/src/routes/deposit-polymarket.ts :: computeDepositWalletAddress
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as const;
const DEPOSIT_WALLET_IMPL    = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB" as const;
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

/**
 * Compute the deterministic Polymarket deposit wallet address for an EOA.
 * Pure client-side — mirrors the treasury's computeDepositWalletAddress exactly.
 * No server calls needed. Works even when orchestrator and treasury are down.
 */
function computeDepositWalletAddress(owner: `0x${string}`): `0x${string}` {
  // args = abi.encode(address factory, bytes32 walletId)
  // walletId = bytes32(owner) = left-pad 20-byte address to 32 bytes
  const walletId = pad(owner, { size: 32 });
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [DEPOSIT_WALLET_FACTORY, walletId],
  );

  const salt = keccak256(args);

  // Solady LibClone.initCodeHashERC1967 — n = byte length of args
  const n = BigInt((args.length - 2) / 2); // args is 0x-prefixed hex
  const combined = ERC1967_PREFIX + (n << 56n);

  // Build initCode: 10-byte prefix | impl (20 bytes) | 0x6009 | CONST2 | CONST1 | args
  const prefixBytes = toBytes(toHex(combined, { size: 10 }));
  const implBytes   = toBytes(DEPOSIT_WALLET_IMPL);
  const sep         = toBytes("0x6009");
  const c2bytes     = toBytes(ERC1967_CONST2 as `0x${string}`);
  const c1bytes     = toBytes(ERC1967_CONST1 as `0x${string}`);
  const argsBytes   = toBytes(args);

  const initCode = concat([prefixBytes, implBytes, sep, c2bytes, c1bytes, argsBytes]);
  const bytecodeHash = keccak256(initCode);

  return getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt,
    bytecodeHash,
  });
}

/**
 * Direct on-chain pUSD balanceOf call via eth_call JSON-RPC.
 * Works regardless of server state — queries Polygon directly.
 */
async function fetchPusdBalanceDirect(walletAddress: string): Promise<string> {
  const data =
    "0x70a08231" +
    walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  try {
    const res = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_call",
        params: [{ to: PUSD_ADDRESS, data }, "latest"],
      }),
    });
    if (!res.ok) return "0.000000";
    const json = (await res.json()) as { result?: string };
    if (!json.result || json.result === "0x") return "0.000000";
    const raw = BigInt(json.result);
    const whole = raw / 1_000_000n;
    const frac  = raw % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, "0")}`;
  } catch {
    return "0.000000";
  }
}

export function useUser(metamaskAddress: string | undefined): UseUserReturn {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BotWalletBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cache the deposit wallet address so on-chain pUSD reads survive orchestrator restarts.
  const depositWalletRef = useRef<string | null>(null);

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
      // Compute deposit wallet address purely client-side — no server needed.
      const depositWalletAddress =
        depositWalletRef.current ??
        computeDepositWalletAddress(metamaskAddress as `0x${string}`);
      depositWalletRef.current = depositWalletAddress;

      // Read pUSD balance directly from Polygon — bypasses Cloudflare, orchestrator, treasury.
      const pusd = await fetchPusdBalanceDirect(depositWalletAddress);

      // Try orchestrator for the full EOA balance (USDT, USDC.e, POL).
      // If it fails, show zeros — the pUSD is what matters for onboarding.
      let data: BotWalletBalance = {
        address: metamaskAddress,
        usdt: "0.000000",
        usdce: "0.000000",
        nativePol: "0.000000",
        depositWalletAddress,
        depositWalletPusd: pusd,
      };
      try {
        const res = await fetch(
          `/api/orchestrator/users/${metamaskAddress}/balance`,
        );
        if (res.ok) {
          const remote = (await res.json()) as BotWalletBalance;
          data = { ...remote, depositWalletAddress, depositWalletPusd: pusd };
        }
      } catch { /* orchestrator may be restarting — pUSD already set above */ }

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
