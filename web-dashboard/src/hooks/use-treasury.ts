import { useCallback, useEffect, useRef, useState } from "react";

export interface AgentWallet {
  name: string;
  address: string;
  balanceUsdT: string;
  usdTBalance?: string;
}

export function useTreasury() {
  const [treasury, setTreasury] = useState<AgentWallet | null>(null);
  const [bots, setBots] = useState<AgentWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/treasury/wallets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        treasury: { address: string; usdTBalance: string };
        bots: { id: number; address: string; usdTBalance: string }[];
      };
      setTreasury({
        name: "Treasury",
        address: data.treasury.address,
        balanceUsdT: data.treasury.usdTBalance,
      });
      setBots(
        data.bots.map((b) => ({
          name: `Bot ${b.id}`,
          address: b.address,
          balanceUsdT: b.usdTBalance,
        })),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Treasury offline");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    timerRef.current = setInterval(fetch_, 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { treasury, bots, loading, error, refresh: fetch_ };
}
