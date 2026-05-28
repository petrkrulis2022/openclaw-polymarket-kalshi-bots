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
  "8": "football-bot",
  "10": "hockey-bot",
};

export function usePortfolio(metamaskAddress?: string) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const summaryUrl = metamaskAddress
        ? `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/portfolio-summary`
        : "/api/orchestrator/portfolio/summary";
      const [res, statusRes] = await Promise.all([
        fetch(summaryUrl),
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
          const statusRow = statusByName.get(botName);
          const isEnabled = statusRow ? Boolean(statusRow.enabled) : true;
          const status = String(statusRow?.status ?? "");
          const isOnline = status.toLowerCase() === "online";
          if (!isEnabled || !isOnline) return [String(b.id), null] as const;
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

      let copyRuntime: {
        equity: number;
        realizedPnl: number;
        openPositions: number;
      } | null = null;
      let hockeyRuntime: {
        equity: number;
        pnl: number;
        openPositions: number;
      } | null = null;

      if (metamaskAddress) {
        try {
          const base = `/api/orchestrator/users/${metamaskAddress}/bots/copy-trader/proxy`;
          const [metricsRes, positionsRes] = await Promise.all([
            fetch(`${base}/metrics`),
            fetch(`${base}/positions`),
          ]);
          if (metricsRes.ok && positionsRes.ok) {
            const metrics = (await metricsRes.json()) as {
              equity?: number;
              realizedPnl?: number;
            };
            const positionsPayload = (await positionsRes.json()) as {
              positions?: Array<{ netSize?: number }>;
              totalRealizedPnl?: number;
            };

            const positions = Array.isArray(positionsPayload.positions)
              ? positionsPayload.positions
              : [];
            const openPositions = positions.filter(
              (p) => Number(p.netSize ?? 0) > 0.001,
            ).length;

            copyRuntime = {
              equity: Number(metrics.equity ?? 0),
              realizedPnl: Number(
                positionsPayload.totalRealizedPnl ?? metrics.realizedPnl ?? 0,
              ),
              openPositions,
            };
          }
        } catch {
          // Keep portfolio summary values if runtime endpoints are unavailable.
        }

        try {
          const hockeyRes = await fetch(
            `/api/orchestrator/users/${metamaskAddress}/bots/hockey-bot/proxy/metrics`,
          );
          if (hockeyRes.ok) {
            const metrics = (await hockeyRes.json()) as {
              equity?: number | string;
              pnl?: number | string;
              openPositions?: number;
            };
            hockeyRuntime = {
              equity: Number(metrics.equity ?? 0),
              pnl: Number(metrics.pnl ?? 0),
              openPositions: Number(metrics.openPositions ?? 0),
            };
          }
        } catch {
          // Keep portfolio summary values if hockey runtime endpoint is unavailable.
        }
      }

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
          const isCopyTrader = String(b.id) === "3";
          const isHockey = String(b.id) === "10";
          const rawEquity = parseFloat(b.equity as string) || 0;
          const rawPnl = parseFloat(b.pnl as string) || 0;
          const rawOpenPositions = Number(b.openPositions) || 0;

          const equity =
            isCopyTrader && copyRuntime
              ? copyRuntime.equity
              : isHockey && hockeyRuntime
                ? hockeyRuntime.equity
                : rawEquity;
          const pnl =
            isCopyTrader && copyRuntime
              ? copyRuntime.realizedPnl
              : isHockey && hockeyRuntime
                ? hockeyRuntime.pnl
                : rawPnl;
          const openPositions =
            isCopyTrader && copyRuntime
              ? copyRuntime.openPositions
              : isHockey && hockeyRuntime
                ? hockeyRuntime.openPositions
                : rawOpenPositions;

          return {
            id: String(b.id),
            name: b.name,
            strategy: b.strategy ?? "",
            // Missing allocation rows mean the bot is enabled by default.
            status: String(
              statusByName.get(BOT_ROUTE_NAMES[String(b.id)] ?? "")?.status ??
                "idle",
            ),
            equity,
            pnl,
            allocationPct: parseFloat(b.allocationPct as string) || 0,
            utilization:
              b.utilization != null ? parseFloat(b.utilization as string) : 0,
            openPositions,
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
