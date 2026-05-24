import { useState, useEffect, useCallback } from "react";

// ── Types mirroring bot API ───────────────────────────────────────────────────

export interface TrackedTrader {
  address: string;
  label: string;
  allocationUsd: number;
  copyRatio: number;
  mode: "manual" | "auto" | "orchestrator";
  enabled: boolean;
  addedAt: string;
}

export interface PendingTrade {
  id: string;
  traderAddress: string;
  traderLabel: string;
  tokenId: string;
  marketTitle: string;
  outcome: string;
  side: "BUY" | "SELL";
  traderDeltaShares: number;
  traderDeltaUsd: number;
  ourTargetShares: number;
  ourTargetUsd: number;
  suggestedPrice: number;
  detectedAt: string;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "executed"
    | "expired"
    | "failed";
  expiresAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  executionPrice: number | null;
  executedSize: number | null;
  executedOrderId: string | null;
  errorMessage: string | null;
}

export interface CopyInventoryPosition {
  tokenId: string;
  sourceTrader: string;
  netSize: number;
  avgPrice: number;
  realizedPnl: number;
}

/** Shape returned by GET /traders/:address/snapshot (mirrors DataApiPosition in bot) */
export interface TraderDataPosition {
  market: string;
  asset: string; // tokenId
  size: string;
  avgPrice: string;
  currentValue: string;
  curPrice: string;
  title: string;
  outcome: string;
}

export interface CopyTraderState {
  traders: TrackedTrader[];
  pending: PendingTrade[];
  positions: CopyInventoryPosition[];
  totalRealizedPnl: number;
  /** keyed by trader address → their live Data API positions */
  traderSnapshots: Record<string, TraderDataPosition[]>;
  online: boolean;
  loading: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const POLL_MS = 5_000;

export function useCopyTrader(metamaskAddress?: string) {
  const [state, setState] = useState<CopyTraderState>({
    traders: [],
    pending: [],
    positions: [],
    totalRealizedPnl: 0,
    traderSnapshots: {},
    online: false,
    loading: true,
  });

  const refresh = useCallback(async () => {
    const base = metamaskAddress
      ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
      : "/api/bot/3";

    try {
      if (metamaskAddress) {
        const statusRes = await fetch(
          `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/status`,
        );
        if (statusRes.ok) {
          const statusList = (await statusRes.json()) as Array<{
            name?: string;
            status?: string;
            enabled?: boolean;
          }>;
          const copyStatus = statusList.find((s) => s.name === "copy-trader");
          if (!copyStatus || copyStatus.status !== "online") {
            setState((s) => ({
              ...s,
              traders: [],
              pending: [],
              positions: [],
              totalRealizedPnl: 0,
              traderSnapshots: {},
              online: false,
              loading: false,
            }));
            return;
          }
        }
      }

      const [tradersRes, pendingRes, positionsRes] = await Promise.all([
        fetch(`${base}/traders`),
        fetch(`${base}/pending`),
        fetch(`${base}/positions`),
      ]);

      if (!tradersRes.ok || !pendingRes.ok || !positionsRes.ok) {
        setState((s) => ({ ...s, online: false, loading: false }));
        return;
      }

      const traders = (await tradersRes.json()) as TrackedTrader[];
      const pending = (await pendingRes.json()) as PendingTrade[];
      const posData = (await positionsRes.json()) as {
        positions: CopyInventoryPosition[];
        totalRealizedPnl: number;
      };

      // Fetch each trader's live Data API snapshot in parallel
      const snapshotEntries = await Promise.all(
        traders.map(async (t) => {
          try {
            const r = await fetch(
              `${base}/traders/${encodeURIComponent(t.address)}/snapshot`,
            );
            if (!r.ok) return [t.address, []] as [string, TraderDataPosition[]];
            const data = (await r.json()) as TraderDataPosition[];
            return [t.address, data] as [string, TraderDataPosition[]];
          } catch {
            return [t.address, []] as [string, TraderDataPosition[]];
          }
        }),
      );
      const traderSnapshots = Object.fromEntries(snapshotEntries);

      setState({
        traders,
        pending,
        positions: posData.positions,
        totalRealizedPnl: posData.totalRealizedPnl,
        traderSnapshots,
        online: true,
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, online: false, loading: false }));
    }
  }, [metamaskAddress]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const addTrader = useCallback(
    async (trader: Omit<TrackedTrader, "addedAt">): Promise<boolean> => {
      try {
        const base = metamaskAddress
          ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
          : "/api/bot/3";
        const res = await fetch(`${base}/traders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trader),
        });
        if (!res.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh, metamaskAddress],
  );

  const removeTrader = useCallback(
    async (address: string): Promise<boolean> => {
      try {
        const base = metamaskAddress
          ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
          : "/api/bot/3";
        const res = await fetch(
          `${base}/traders/${encodeURIComponent(address)}`,
          {
            method: "DELETE",
          },
        );
        if (!res.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh, metamaskAddress],
  );

  const updateTrader = useCallback(
    async (
      address: string,
      patch: Partial<Omit<TrackedTrader, "address" | "addedAt">>,
    ): Promise<boolean> => {
      try {
        const base = metamaskAddress
          ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
          : "/api/bot/3";
        const res = await fetch(
          `${base}/traders/${encodeURIComponent(address)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        if (!res.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh, metamaskAddress],
  );

  const approveTrade = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const base = metamaskAddress
          ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
          : "/api/bot/3";
        const res = await fetch(
          `${base}/pending/${encodeURIComponent(id)}/approve`,
          {
            method: "POST",
          },
        );
        if (!res.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh, metamaskAddress],
  );

  const rejectTrade = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const base = metamaskAddress
          ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/copy-trader/proxy`
          : "/api/bot/3";
        const res = await fetch(
          `${base}/pending/${encodeURIComponent(id)}/reject`,
          {
            method: "POST",
          },
        );
        if (!res.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh, metamaskAddress],
  );

  return {
    ...state,
    refresh,
    addTrader,
    removeTrader,
    updateTrader,
    approveTrade,
    rejectTrade,
  };
}
