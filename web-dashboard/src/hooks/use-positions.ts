import { useCallback, useEffect, useRef, useState } from "react";

export interface SharePosition {
  conditionId: string; // bytes32 hex
  tokenId: string; // decimal string (ERC-1155 id)
  title: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  curPrice: number;
  redeemable: boolean;
  negativeRisk: boolean;
  endDate: string;
  /** Which wallet holds this position — either depositWallet or the bot's proxy wallet */
  sourceWallet: string;
  /**
   * Derived status:
   * - "redeemable" — market resolved and this outcome won; can redeem for $1/share
   * - "pending"    — market still active or resolving
   * - "resolved"   — market resolved but this outcome lost; worth $0
   */
  status: "redeemable" | "pending" | "resolved";
  /** Realized or unrealized PnL in USD: (curPrice - avgPrice) * size */
  pnl: number;
  /** Bot that opened this position, if known */
  botName: string | null;
}

export interface PositionsSummary {
  totalSharesValue: number;
  redeemableCount: number;
  redeemableValue: number;
}

export function usePositions(
  depositWallet: string | undefined,
  botWallet?: string | undefined,
  userAddress?: string | undefined,
) {
  const [positions, setPositions] = useState<SharePosition[]>([]);
  const [summary, setSummary] = useState<PositionsSummary>({
    totalSharesValue: 0,
    redeemableCount: 0,
    redeemableValue: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    if (!depositWallet) return;
    try {
      const botWalletParam =
        botWallet && botWallet.toLowerCase() !== depositWallet.toLowerCase()
          ? `&botWallet=${encodeURIComponent(botWallet)}`
          : "";

      // Use attributed endpoint when userAddress is available — includes botName per position
      const posUrl = userAddress
        ? `/api/orchestrator/positions/by-user?address=${encodeURIComponent(userAddress)}&depositWallet=${encodeURIComponent(depositWallet)}`
        : `/api/orchestrator/positions?depositWallet=${encodeURIComponent(depositWallet)}${botWalletParam}`;

      const [posRes, sumRes] = await Promise.all([
        fetch(posUrl),
        fetch(
          `/api/orchestrator/positions/summary?depositWallet=${encodeURIComponent(depositWallet)}${botWalletParam}`,
        ),
      ]);

      if (posRes.ok) {
        const raw = await posRes.json();
        const mapped: SharePosition[] = (raw.positions ?? []).map(
          (p: Record<string, unknown>) => ({
            conditionId: String(p["conditionId"] ?? ""),
            tokenId: String(p["asset"] ?? ""),
            title: String(p["title"] ?? ""),
            outcome: String(p["outcome"] ?? ""),
            outcomeIndex: Number(p["outcomeIndex"] ?? 0),
            size: Number(p["size"] ?? 0),
            avgPrice: Number(p["avgPrice"] ?? 0),
            initialValue: Number(p["initialValue"] ?? 0),
            currentValue: Number(p["currentValue"] ?? 0),
            cashPnl: Number(p["cashPnl"] ?? 0),
            curPrice: Number(p["curPrice"] ?? 0),
            redeemable: Boolean(p["redeemable"]),
            negativeRisk: Boolean(p["negativeRisk"]),
            endDate: String(p["endDate"] ?? ""),
            sourceWallet: String(p["sourceWallet"] ?? depositWallet),
            status: Boolean(p["redeemable"])
              ? "redeemable"
              : Number(p["curPrice"] ?? 0) === 0 &&
                  String(p["endDate"] ?? "") !== ""
                ? "resolved"
                : "pending",
            pnl: Number(p["cashPnl"] ?? 0),
            botName: p["botName"] ? String(p["botName"]) : null,
          }),
        );
        setPositions(mapped);
      }

      if (sumRes.ok) {
        const s = await sumRes.json();
        setSummary({
          totalSharesValue: Number(s.totalSharesValue) || 0,
          redeemableCount: Number(s.redeemableCount) || 0,
          redeemableValue: Number(s.redeemableValue) || 0,
        });
      }

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load positions");
    } finally {
      setLoading(false);
    }
  }, [depositWallet, botWallet, userAddress]);

  useEffect(() => {
    if (!depositWallet) return;
    setLoading(true);
    fetch_();
    timerRef.current = setInterval(fetch_, 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_, depositWallet, botWallet]);

  return { positions, summary, loading, error, refresh: fetch_ };
}
