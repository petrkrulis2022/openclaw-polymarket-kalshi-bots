import { useCallback, useEffect, useRef, useState } from "react";

export interface BotSummary {
  id: string;
  name: string;
  strategy: string;
  status: string;
  equity: number;
  pnl: number;
  allocationPct: number;
  utilization: number;
  openPositions: number;
  enabled: boolean;
  health: "healthy" | "paused" | "offline" | "unknown";
  lastDiagnosticsAt: string | null;
  lastReconcileAt: string | null;
}

export interface Portfolio {
  totalEquity: number;
  totalPnl: number;
  bots: BotSummary[];
}

const BOT_ROUTE_NAMES: Record<string, string> = {
  "1": "market-maker",
  "3": "copy-trader",
  "4": "in-market-arb",
  "5": "resolution-lag",
  "6": "microstructure",
};

export function usePortfolio(metamaskAddress?: string) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [res, statusRes] = await Promise.all([
        fetch("/api/orchestrator/portfolio/summary"),
        metamaskAddress
          ? fetch(`/api/orchestrator/users/${metamaskAddress}/bots/status`)
          : Promise.resolve(null),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const statusRows =
        statusRes && statusRes.ok ? await statusRes.json() : [];
      const statusByName = new Map<string, Record<string, unknown>>();
      for (const row of Array.isArray(statusRows) ? statusRows : []) {
        statusByName.set(String(row.name), row as Record<string, unknown>);
      }

      const diagnosticsEntries = await Promise.all(
        (raw.bots ?? []).map(async (b: Record<string, unknown>) => {
          if (!metamaskAddress) return [String(b.id), null] as const;
          const botName = BOT_ROUTE_NAMES[String(b.id)];
          if (!botName) return [String(b.id), null] as const;
          try {
            const diagRes = await fetch(
              `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/diagnostics`,
            );
            if (!diagRes.ok) return [String(b.id), null] as const;
            return [
              String(b.id),
              (await diagRes.json()) as Record<string, unknown>,
            ] as const;
          } catch {
            return [String(b.id), null] as const;
          }
        }),
      );
      const diagnosticsById = new Map(diagnosticsEntries);

      const data: Portfolio = {
        totalEquity: parseFloat(raw.totalEquity) || 0,
        totalPnl: parseFloat(raw.totalPnl) || 0,
        bots: (raw.bots ?? []).map((b: Record<string, unknown>) => {
          const maybeDiag = diagnosticsById.get(String(b.id));
          const diag =
            maybeDiag && typeof maybeDiag === "object"
              ? (maybeDiag as {
                  ok?: boolean;
                  healthy?: boolean;
                  lastReconcileAt?: string;
                  lastScanAt?: string;
                })
              : undefined;
          return {
            id: String(b.id),
            name: b.name,
            strategy: b.strategy ?? "",
            // Missing allocation rows mean the bot is enabled by default.
            status: String(
              statusByName.get(BOT_ROUTE_NAMES[String(b.id)] ?? "")?.status ??
                "idle",
            ),
            equity: parseFloat(b.equity as string) || 0,
            pnl: parseFloat(b.pnl as string) || 0,
            allocationPct: parseFloat(b.allocationPct as string) || 0,
            utilization:
              b.utilization != null ? parseFloat(b.utilization as string) : 0,
            openPositions: Number(b.openPositions) || 0,
            enabled: statusByName.get(BOT_ROUTE_NAMES[String(b.id)] ?? "")
              ? Boolean(
                  statusByName.get(BOT_ROUTE_NAMES[String(b.id)] ?? "")
                    ?.enabled,
                )
              : true,
            health:
              diag?.ok === false
                ? "offline"
                : diag?.healthy === false
                  ? "paused"
                  : diag
                    ? "healthy"
                    : "unknown",
            lastDiagnosticsAt:
              (diag?.lastReconcileAt as string) ??
              (diag?.lastScanAt as string) ??
              null,
            lastReconcileAt: (diag?.lastReconcileAt as string) ?? null,
          };
        }),
      };
      setPortfolio(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Orchestrator offline");
    } finally {
      setLoading(false);
    }
  }, [metamaskAddress]);

  useEffect(() => {
    fetch_();
    timerRef.current = setInterval(fetch_, 5_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_]);

  return { portfolio, loading, error, refresh: fetch_ };
}
