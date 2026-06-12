import React from "react";
import { useMonitoring, type MonitoringBotCard } from "../hooks/use-monitoring";

interface Props {
  onBack: () => void;
  metamaskAddress?: string;
  onSelectBot: (botId: string, card: MonitoringBotCard) => void;
}

const BOT_LABELS: Record<string, string> = {
  "market-maker": "Market Maker",
  "copy-trader": "Copy Trader",
  "in-market-arb": "In-Market Arb",
  "resolution-lag": "Resolution Lag",
  "microstructure": "Microstructure",
  "kalshi-arb": "Kalshi Arb",
};

function statusDotColor(status: MonitoringBotCard["status"]): string {
  if (status === "online") return "#4caf50";
  if (status === "stopped") return "#ff9500";
  return "#ff3b30";
}

function statusLabel(status: MonitoringBotCard["status"]): string {
  if (status === "online") return "online";
  if (status === "stopped") return "stopped";
  return "offline";
}

function statusBadgeColor(status: MonitoringBotCard["status"]): string {
  if (status === "online") return "rgba(76,175,80,0.15)";
  if (status === "stopped") return "rgba(255,149,0,0.15)";
  return "rgba(255,59,48,0.15)";
}

function fmt$(n: number | null): string {
  if (n === null) return "---";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtNum(n: unknown): string {
  if (n === null || n === undefined) return "---";
  return String(n);
}

function relTime(iso: string | null): string {
  if (!iso) return "---";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

interface LearningRecord {
  status?: string;
  sampleSize?: number;
  lastLearnAt?: string;
  categoryBlocklist?: string[];
  params?: { minYieldPct?: number };
  notes?: string[];
}

function LearningRow({ extra }: { extra: Record<string, unknown> | null }) {
  if (!extra?.learning) return null;
  const lr = extra.learning as LearningRecord;
  if (lr.status === "no_data") {
    return (
      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
        Learning: waiting for resolved positions (min 5)
      </div>
    );
  }
  const blocked = lr.categoryBlocklist?.length ?? 0;
  const minYield = lr.params?.minYieldPct;
  const lastNote = lr.notes?.length ? lr.notes[lr.notes.length - 1] : undefined;
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--text-secondary)",
        marginTop: 6,
        paddingTop: 6,
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--text)", fontWeight: 600 }}>Learning</span>
      <span>{lr.sampleSize ?? 0} trades</span>
      {minYield !== undefined && <span>minYield {minYield}%</span>}
      {blocked > 0 && <span>{blocked} categor{blocked === 1 ? "y" : "ies"} blocked</span>}
      {lr.lastLearnAt && <span>· {relTime(lr.lastLearnAt)}</span>}
      {lastNote && (
        <span style={{ fontStyle: "italic", opacity: 0.7 }} title={lastNote}>
          {lastNote.length > 50 ? lastNote.slice(0, 50) + "…" : lastNote}
        </span>
      )}
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString();
}

interface ExtraCols {
  labelA: string;
  valA: string;
  labelB: string;
  valB: string;
}

function extraCols(card: MonitoringBotCard): ExtraCols {
  const e = card.extra ?? {};
  const n = (k: string) => fmtNum(e[k]);

  switch (card.botName) {
    case "market-maker":
      return {
        labelA: "Markets",
        valA: n("marketsQuoted"),
        labelB: "Positions",
        valB: n("inventoryPositions"),
      };
    case "copy-trader":
      return {
        labelA: "Traders",
        valA: n("tradersTracked"),
        labelB: "Pending",
        valB: n("pendingApprovals"),
      };
    case "in-market-arb":
      return {
        labelA: "Binary Pairs",
        valA: n("activeBinaryPairs"),
        labelB: "NegRisk Pairs",
        valB: n("activeNegRiskPairs"),
      };
    case "resolution-lag":
      return {
        labelA: "Open Pos",
        valA: n("openPositions"),
        labelB: "Opportunities",
        valB: n("lastOpportunities"),
      };
    case "microstructure":
      return {
        labelA: "Screened Mkts",
        valA: n("screenedMarkets"),
        labelB: "Open Pos",
        valB: n("openPositions"),
      };
    case "kalshi-arb":
      return {
        labelA: "Open Pairs",
        valA: n("openPairs"),
        labelB: "Signals",
        valB: n("lastSignals"),
      };
    default:
      return { labelA: "—", valA: "---", labelB: "—", valB: "---" };
  }
}

interface ActivityEntry {
  seq: number;
  ts: string;
  event: string;
  level: "info" | "warn" | "error";
  detail?: Record<string, unknown>;
}

function levelColor(l: ActivityEntry["level"]): string {
  if (l === "error") return "#ff3b30";
  if (l === "warn") return "#ff9500";
  return "var(--text-secondary)";
}

function dNum(v: unknown, digits = 2): string {
  return typeof v === "number" ? v.toFixed(digits) : "?";
}

function dStr(v: unknown, max = 60): string {
  const s = typeof v === "string" ? v : "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function describeActivity(e: ActivityEntry): string {
  const d = e.detail ?? {};
  switch (e.event) {
    case "scan_complete":
      if ("binaryMarkets" in d)
        return `Scan: ${d.binaryMarkets} binary, ${d.negRiskGroups} negRisk — ${d.signals} signal(s)`;
      if ("kalshiMarkets" in d)
        return `Scan: ${d.kalshiMarkets} Kalshi mkts, ${d.matchedPairs} pairs — ${d.signals} signal(s)`;
      if ("closedMarkets" in d)
        return `Scan: ${d.closedMarkets} closed mkts, ${d.opportunities} opps — ${d.actionable} actionable`;
      return `Scan complete`;
    case "scan_skipped":
      return `Scan skipped (${d.reason})`;
    case "scan_error":
    case "quote_cycle_error":
    case "poll_error":
      return `Error: ${dStr(d.message, 80)}`;
    case "signal_found":
      return d.kind === "binary"
        ? `Signal: ${dStr(d.market)} — profit $${dNum(d.profitUsd, 4)}`
        : `NegRisk signal: ${dStr(d.group)} (${d.legs} legs) — profit $${dNum(d.profitUsd, 4)}`;
    case "signal_execute":
      return `Executing ${dStr(d.ticker, 30)} — edge ${dNum(d.edgePct)}% $${dNum(d.sizeUsd)}${d.dryRun ? " (dry-run)" : ""}`;
    case "signal_detected":
      return `Copy signal: ${d.side} ${dStr(d.market, 45)} (trader ${dStr(d.trader, 20)}, ${d.mode})`;
    case "pair_placed":
      return "market" in d
        ? `Pair placed: ${dStr(d.market, 45)} YES@${dNum(d.yesPrice, 3)} NO@${dNum(d.noPrice, 3)}`
        : `Pair placed ($${dNum(d.sizeUsd)})`;
    case "pair_place_failed":
    case "pair_failed":
      return `Pair failed: ${dStr(d.message, 70)}`;
    case "pair_timeout_cancelled":
      return `Pair timed out (yes ${dNum(d.yesFilled)}, no ${dNum(d.noFilled)} filled) — cancelled`;
    case "pair_settled":
      return `Pair settled — PnL $${dNum(d.pnlUsd, 4)}`;
    case "pair_closed":
      return `Pair closed early — PnL $${dNum(d.realizedPnl, 4)}`;
    case "close_attempt":
      return `Closing pair (sell value ${dNum(d.combinedSellValue, 4)})${d.dryRun ? " (dry-run)" : ""}`;
    case "close_failed":
      return `Early close failed`;
    case "leg_cancelled":
      return `Orphan leg cancelled`;
    case "merge_attempted":
      return `CTF merge: ${dNum(d.amount)} share-pairs → USDC`;
    case "merge_complete":
      return `CTF merge confirmed (${dStr(d.txHash, 18)})`;
    case "merge_failed":
      return `CTF merge FAILED: ${dStr(d.message, 70)}`;
    case "negrisk_placed":
      return `NegRisk placed: ${dStr(d.group, 45)} (${d.legs} legs, $${dNum(d.totalCostUsd)})`;
    case "negrisk_leg_failed":
      return `NegRisk leg failed: ${dStr(d.message, 60)}`;
    case "negrisk_timeout_cancelled":
      return `NegRisk pair timed out — cancelled`;
    case "execution_skipped":
      return `Execution skipped (${d.reason})`;
    case "execute_error":
    case "enter_error":
    case "order_failed":
      return `Order error: ${dStr(d.message, 70)}`;
    case "opportunity_found":
      return `Opportunity: ${dStr(d.market, 45)} @ ${dNum(d.ask, 3)} (${dNum(d.yieldPct)}% yield)`;
    case "position_entered":
      return `Entered: ${dStr(d.market, 45)} @ ${dNum(d.ask, 3)} × ${dNum(d.sizeShares, 1)}`;
    case "position_resolved":
      return `Resolved at $1: ${dStr(d.market, 50)}`;
    case "quote_cycle_complete":
      return "screened" in d
        ? `Quote cycle: ${d.quoted}/${d.screened} screened markets quoted`
        : `Quote cycle: ${d.markets} market(s) quoted`;
    case "quote_skipped":
      return `Quoting skipped (${d.reason})`;
    case "quotes_posted":
      return `Quotes: ${dStr(d.market, 40)} bid ${d.bid != null ? dNum(d.bid, 3) : "—"} / ask ${d.ask != null ? dNum(d.ask, 3) : "—"}`;
    case "paper_fill":
      return `Paper fill: ${d.side} ${dNum(d.size, 1)} @ ${dNum(d.price, 3)}`;
    case "market_unwound":
      return `Unwound ${dNum(d.shares, 1)} shares @ ${dNum(d.sellPrice, 3)}`;
    case "unwind_failed":
      return `Unwind FAILED: ${dStr(d.message, 60)}`;
    case "screen_complete":
      return `Screen: ${d.passed} market(s) pass filter`;
    case "screen_error":
      return `Screener error: ${dStr(d.message, 70)}`;
    case "trade_executed":
      return `Executed: ${d.side} ${dNum(d.shares, 1)} @ ${dNum(d.price, 3)} (copy ${dStr(d.trader, 20)})`;
    case "trade_approved":
      return `Approved: ${dStr(d.market, 50)}`;
    case "trade_rejected":
      return `Rejected trade ${dStr(d.id, 12)}`;
    case "trade_skipped":
      return `Trade skipped (${d.reason})`;
    case "trade_failed":
      return `Trade FAILED: ${dStr(d.message, 70)}`;
    case "leg_naked":
      return `NAKED LEG (${d.leg}) — unwinding`;
    case "leg_unwound":
      return `Naked leg unwound (${d.leg}) — loss $${dNum(d.lossUsd, 4)}`;
    case "unwind_retry":
      return `Unwind retry #${d.attempts} (${d.leg} leg still naked)`;
    default:
      return `${e.event} ${JSON.stringify(e.detail ?? {})}`.slice(0, 100);
  }
}

function BotActivityPanel({
  botName,
  metamaskAddress,
}: {
  botName: string;
  metamaskAddress?: string;
}) {
  const [entries, setEntries] = React.useState<ActivityEntry[] | null>(null);
  const [fetchError, setFetchError] = React.useState(false);

  React.useEffect(() => {
    if (!metamaskAddress) return;
    let cancelled = false;
    const url = `/api/orchestrator/users/${encodeURIComponent(metamaskAddress)}/bots/${botName}/proxy/activity?limit=50`;
    const load = () => {
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d) => {
          if (cancelled) return;
          setEntries(((d as { entries?: ActivityEntry[] }).entries ?? []).slice().reverse());
          setFetchError(false);
        })
        .catch(() => {
          if (!cancelled) setFetchError(true);
        });
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [botName, metamaskAddress]);

  if (!metamaskAddress) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
        Connect wallet to view activity.
      </div>
    );
  }
  if (fetchError && !entries) {
    return (
      <div style={{ fontSize: 12, color: "#ff9500", marginTop: 8 }}>
        Activity unavailable — bot offline?
      </div>
    );
  }
  if (!entries) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
        Loading activity…
      </div>
    );
  }

  const newestCycle = entries.find((e) =>
    ["scan_complete", "quote_cycle_complete", "screen_complete"].includes(e.event),
  );

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid var(--border)",
      }}
    >
      {newestCycle && (
        <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 8 }}>
          {describeActivity(newestCycle)}{" "}
          <span style={{ color: "var(--text-secondary)" }}>
            · {relTime(newestCycle.ts)}
          </span>
        </div>
      )}
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          No recorded activity yet (buffer resets on restart).
        </div>
      ) : (
        <div
          style={{
            maxHeight: 240,
            overflowY: "auto",
            fontSize: 11,
            fontFamily: "monospace",
            lineHeight: 1.7,
          }}
        >
          {entries.map((e) => (
            <div key={e.seq} style={{ display: "flex", gap: 8 }}>
              <span style={{ color: "var(--text-secondary)", flexShrink: 0, width: 64 }}>
                {relTime(e.ts)}
              </span>
              <span style={{ color: levelColor(e.level) }}>{describeActivity(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BotCard({
  card,
  onSelect,
  metamaskAddress,
}: {
  card: MonitoringBotCard;
  onSelect: (card: MonitoringBotCard) => void;
  metamaskAddress?: string;
}) {
  const cols = extraCols(card);
  const isOffline = card.status !== "online";
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      className="card"
      style={{
        marginBottom: 12,
        opacity: isOffline ? 0.65 : 1,
        transition: "opacity 0.3s",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="status-dot"
            style={{ background: statusDotColor(card.status), flexShrink: 0 }}
          />
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {BOT_LABELS[card.botName] ?? card.botName}
          </span>
        </div>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 10,
            background: statusBadgeColor(card.status),
            color: statusDotColor(card.status),
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {statusLabel(card.status)}
        </span>
      </div>

      {/* Metrics row */}
      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
        <div>
          <div className="metric-val">{card.equity !== null ? `$${card.equity.toFixed(2)}` : "---"}</div>
          <div className="metric-lbl">Equity</div>
        </div>
        <div>
          <div
            className="metric-val"
            style={{ color: card.pnl !== null ? (card.pnl >= 0 ? "#4caf50" : "#ff3b30") : undefined }}
          >
            {fmt$(card.pnl)}
          </div>
          <div className="metric-lbl">P&L</div>
        </div>
        <div>
          <div className="metric-val">{cols.valA}</div>
          <div className="metric-lbl">{cols.labelA}</div>
        </div>
        <div>
          <div className="metric-val">{cols.valB}</div>
          <div className="metric-lbl">{cols.labelB}</div>
        </div>
      </div>

      {/* Footer row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {card.lastActivityAt
            ? `Last active: ${relTime(card.lastActivityAt)}`
            : card.error
              ? card.error
              : "No activity yet"}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn-secondary"
            style={{ fontSize: 12, padding: "3px 10px" }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide Activity ▴" : "Activity ▾"}
          </button>
          <button
            className="btn-secondary"
            style={{ fontSize: 12, padding: "3px 10px" }}
            onClick={() => onSelect(card)}
          >
            View Details
          </button>
        </div>
      </div>

      {card.botName === "resolution-lag" && <LearningRow extra={card.extra} />}
      {expanded && (
        <BotActivityPanel botName={card.botName} metamaskAddress={metamaskAddress} />
      )}
    </div>
  );
}

interface FillRow {
  ts: string;
  botId: string;
  side: string;
  signalPrice: number;
  fillPrice: number;
  fillShares: number;
  fillUsdc: number;
  fillStatus: string;
}

export function MonitoringDashboard({ onBack, metamaskAddress, onSelectBot }: Props) {
  const { data, loading, error } = useMonitoring(metamaskAddress);
  const [fills, setFills] = React.useState<FillRow[]>([]);

  React.useEffect(() => {
    const load = () => {
      fetch("/api/orchestrator/fills?limit=50")
        .then((r) => r.json())
        .then((d) => {
          const rows = ((d as { fills?: FillRow[] }).fills ?? []).slice().reverse();
          setFills(rows);
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        overflowY: "auto",
        background: "var(--bg, #111)",
      }}
    >
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 16px 32px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 0",
          borderBottom: "1px solid var(--border)",
          marginBottom: 20,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            borderRadius: 6,
            padding: "4px 12px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          Bot Monitoring
        </h2>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-secondary)" }}>
          {loading && data.bots.length === 0
            ? "Loading…"
            : error
              ? `Error: ${error}`
              : data.fetchedAt
                ? `Updated ${fmtTime(data.fetchedAt)}`
                : ""}
        </span>
      </div>

      {/* Bot cards */}
      {data.bots.length === 0 && !loading ? (
        <div style={{ color: "var(--text-secondary)", textAlign: "center", padding: 40 }}>
          No bot data available. Ensure bots are started.
        </div>
      ) : (
        data.bots.map((card) => (
          <BotCard
            key={card.botName}
            card={card}
            onSelect={(c) => onSelectBot(String(c.botId), c)}
            metamaskAddress={metamaskAddress}
          />
        ))
      )}

      {/* Recent fills */}
      <div
        className="card"
        style={{ marginTop: 24 }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 12,
          }}
        >
          Recent Fills ({fills.length})
        </div>
        {fills.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            No fills recorded yet. Fills appear here after bots execute live orders.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Time</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Bot</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Side</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Signal¢</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Fill¢</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Slip¢</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>USDC</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f, i) => {
                  const slip = (f.fillPrice - f.signalPrice) * 100;
                  const slipColor = slip > 0.5 ? "#ff6b6b" : slip < -0.5 ? "#30d158" : "var(--text-secondary)";
                  return (
                    <tr
                      key={i}
                      style={{
                        borderTop: "1px solid var(--border)",
                        opacity: f.fillStatus === "zero" ? 0.5 : 1,
                      }}
                    >
                      <td style={{ padding: "5px 8px", color: "var(--text-secondary)" }}>
                        {new Date(f.ts).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: "5px 8px" }}>{f.botId}</td>
                      <td
                        style={{
                          padding: "5px 8px",
                          color: f.side === "BUY" ? "#30d158" : "#ff9500",
                          fontWeight: 600,
                        }}
                      >
                        {f.side}
                      </td>
                      <td style={{ padding: "5px 8px", textAlign: "right" }}>
                        {(f.signalPrice * 100).toFixed(1)}
                      </td>
                      <td style={{ padding: "5px 8px", textAlign: "right" }}>
                        {(f.fillPrice * 100).toFixed(1)}
                      </td>
                      <td style={{ padding: "5px 8px", textAlign: "right", color: slipColor }}>
                        {slip > 0 ? "+" : ""}{slip.toFixed(1)}
                      </td>
                      <td style={{ padding: "5px 8px", textAlign: "right" }}>
                        ${f.fillUsdc.toFixed(2)}
                      </td>
                      <td
                        style={{
                          padding: "5px 8px",
                          color:
                            f.fillStatus === "filled"
                              ? "#30d158"
                              : f.fillStatus === "zero"
                                ? "#ff3b30"
                                : "#ff9500",
                        }}
                      >
                        {f.fillStatus}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
