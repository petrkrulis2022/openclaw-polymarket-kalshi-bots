import React, { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { usePortfolio, type BotSummary } from "./hooks/use-portfolio";
import {
  useBotDetail,
  type MarketPosition,
  type InventoryPosition,
} from "./hooks/use-bot-detail";
import {
  useCopyTrader,
  type TrackedTrader as CopyTrader,
  type PendingTrade,
  type CopyInventoryPosition,
  type TraderDataPosition,
} from "./hooks/use-copy-trader";
import { BotConfigPanel } from "./components/BotConfigPanel";
import { OpenClawChat } from "./components/OpenClawChat";
import { useInMarketArb } from "./hooks/use-in-market-arb";
import { useResolutionLag } from "./hooks/use-resolution-lag";
import { useMicrostructure } from "./hooks/use-microstructure";
import { useUser } from "./hooks/use-user";
import { UserOnboarding } from "./components/UserOnboarding";
import { AdminPanel } from "./components/AdminPanel";
import "./index.css";

function abbrev(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function pnlClass(v: number) {
  return v >= 0 ? "pnl-positive" : "pnl-negative";
}

function statusColor(s: string) {
  return s === "running"
    ? "#4caf50"
    : s === "paused"
      ? "#ff9500"
      : s === "stopped"
        ? "#ff3b30"
        : "#666";
}

// ── Wallet section ──────────────────────────────────────────────────────────
function WalletSection() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  return (
    <div className="card card-accent">
      <div className="section-label">Your Wallet</div>
      {!isConnected ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
            Connect MetaMask to access your OpenClaw bot
          </span>
          <button
            className="btn-primary"
            onClick={() => connect({ connector: connectors[0] })}
          >
            Connect MetaMask
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div
            className="wallet-address"
            title="Click to copy"
            onClick={() => navigator.clipboard.writeText(address!)}
          >
            {abbrev(address!)} 📋
          </div>
          <button className="btn-secondary" onClick={() => disconnect()}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

// ── Bot card ─────────────────────────────────────────────────────────────────
function BotCard({ bot, onClick }: { bot: BotSummary; onClick: () => void }) {
  return (
    <div
      className="bot-card"
      onClick={onClick}
      style={{ cursor: "pointer" }}
      title="Click to open bot dashboard"
    >
      <div className="bot-header">
        <div className="bot-name">
          <div
            className="status-dot"
            style={{ background: statusColor(bot.status) }}
          />
          {bot.name}
        </div>
        <span className="badge">{bot.strategy}</span>
      </div>
      <div className="metrics-row">
        <div>
          <div className="metric-val">${bot.equity.toFixed(2)}</div>
          <div className="metric-lbl">Equity</div>
        </div>
        <div>
          <div className={`metric-val ${pnlClass(bot.pnl)}`}>
            {bot.pnl >= 0 ? "+" : ""}${bot.pnl.toFixed(2)}
          </div>
          <div className="metric-lbl">PnL</div>
        </div>
        <div>
          <div className="metric-val">{bot.allocationPct.toFixed(0)}%</div>
          <div className="metric-lbl">Alloc</div>
        </div>
        <div>
          <div className="metric-val">{bot.openPositions}</div>
          <div className="metric-lbl">Positions</div>
        </div>
      </div>
      {bot.utilization > 0 && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              height: 4,
              background: "var(--border)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(bot.utilization, 100)}%`,
                background: "var(--primary)",
                borderRadius: 2,
              }}
            />
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              marginTop: 3,
              textAlign: "right",
            }}
          >
            {bot.utilization.toFixed(0)}% utilized
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bot detail view ───────────────────────────────────────────────────────────
function BotDetailView({
  bot,
  onBack,
}: {
  bot: BotSummary;
  onBack: () => void;
}) {
  const { detail, loading, error } = useBotDetail(Number(bot.id));
  const markets = detail?.markets ?? null;
  const inventory = detail?.inventory ?? null;
  const totalRealizedPnl = detail?.totalRealizedPnl ?? null;
  const strategyPnl = detail?.strategyPnl ?? null;
  const positionPnl = detail?.positionPnl ?? null;
  const lockedCollateral = detail?.lockedCollateral ?? null;
  const allocatedEquity = detail?.allocatedEquity ?? null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{bot.name}</div>
        <span className="badge">{bot.strategy}</span>
        <div
          className="status-dot"
          style={{ background: statusColor(bot.status), marginLeft: 4 }}
        />
      </div>

      {/* summary cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Allocated Equity</div>
          <div className="balance-big">
            ${(allocatedEquity ?? bot.equity).toFixed(2)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Strategy PnL</div>
          <div
            className={`balance-big ${pnlClass(strategyPnl ?? 0)}`}
            title="Realized profit from bid-ask spread fills"
          >
            {(strategyPnl ?? 0) >= 0 ? "+" : ""}${(strategyPnl ?? 0).toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Position PnL</div>
          <div
            className={`balance-big ${pnlClass(positionPnl ?? 0)}`}
            title="Unrealized PnL on shares held vs current market mid"
          >
            {(positionPnl ?? 0) >= 0 ? "+" : ""}${(positionPnl ?? 0).toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Locked in Polymarket</div>
          <div
            className="balance-big"
            title="USDC.e reserved by open BUY orders"
          >
            ${(lockedCollateral ?? 0).toFixed(2)}
          </div>
        </div>
      </div>

      {loading && <p className="offline">Loading positions…</p>}
      {error && <p className="offline">⚠ Bot offline — {error}</p>}

      {/* market quotes table */}
      {markets && markets.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="section-label" style={{ marginBottom: 10 }}>
            Active Market Quotes
          </div>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Market",
                    "Mid",
                    "Spread",
                    "Our Bid",
                    "Our Ask",
                    "Positions",
                    "Vol 24h",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {markets.map((m: MarketPosition) => (
                  <tr
                    key={m.conditionId}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textAlign: "left",
                      }}
                      title={m.question}
                    >
                      {m.question}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {m.mid != null ? m.mid.toFixed(3) : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {m.spread != null ? m.spread.toFixed(3) : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "#4caf50",
                      }}
                    >
                      {m.ourBidPrice != null ? m.ourBidPrice.toFixed(3) : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "#ff6b6b",
                      }}
                    >
                      {m.ourAskPrice != null ? m.ourAskPrice.toFixed(3) : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {m.openPositions ?? 0}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      ${((m.volume24hr ?? 0) / 1000).toFixed(1)}k
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* inventory / fills table */}
      {inventory && inventory.length > 0 && (
        <div>
          <div className="section-label" style={{ marginBottom: 10 }}>
            Inventory / Fills
          </div>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Token ID",
                    "Net Size",
                    "Avg Price",
                    "Current Mid",
                    "Strategy PnL",
                    "Position PnL",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventory.map((p: InventoryPosition) => (
                  <tr
                    key={p.tokenId}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "monospace",
                        fontSize: 11,
                        textAlign: "left",
                      }}
                      title={p.tokenId}
                    >
                      {p.tokenId.slice(0, 12)}…
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.netSize.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.avgPrice != null ? p.avgPrice.toFixed(4) : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {p.currentMid != null ? p.currentMid.toFixed(4) : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: p.realizedPnl >= 0 ? "#4caf50" : "#ff6b6b",
                      }}
                    >
                      {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(4)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color:
                          p.unrealizedPnl == null
                            ? "var(--text-secondary)"
                            : p.unrealizedPnl >= 0
                              ? "#4caf50"
                              : "#ff6b6b",
                      }}
                    >
                      {p.unrealizedPnl == null
                        ? "—"
                        : `${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(4)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading &&
        !error &&
        markets?.length === 0 &&
        inventory?.length === 0 && (
          <p
            style={{
              color: "var(--text-secondary)",
              textAlign: "center",
              marginTop: 40,
            }}
          >
            No active quotes yet — bot is warming up…
          </p>
        )}

      {/* ── Strategy Configuration + OpenClaw Agent ── */}
      <div style={{ marginTop: 32 }}>
        {bot.id === "1" && <BotConfigPanel botId={1} />}
        <OpenClawChat botId={Number(bot.id)} />
      </div>
    </div>
  );
}

// ── Copy Trader View ──────────────────────────────────────────────────────────
function CopyTraderView({
  bot,
  onBack,
}: {
  bot: BotSummary;
  onBack: () => void;
}) {
  const {
    traders,
    pending,
    positions,
    totalRealizedPnl,
    traderSnapshots,
    online,
    loading,
    addTrader,
    removeTrader,
    updateTrader,
    approveTrade,
    rejectTrade,
  } = useCopyTrader();

  // Add trader form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formAddress, setFormAddress] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formAllocation, setFormAllocation] = useState("50");
  const [formRatio, setFormRatio] = useState("1.0");
  const [formMode, setFormMode] = useState<CopyTrader["mode"]>("manual");
  const [formError, setFormError] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  /** Accept raw 0x address OR full Polymarket profile URL */
  function parsePolymarketAddress(raw: string): string {
    const trimmed = raw.trim();
    // e.g. https://polymarket.com/profile/0xABC... or polymarket.com/profile/0xABC...
    const urlMatch = trimmed.match(/\/profile\/(0x[0-9a-fA-F]+)/i);
    if (urlMatch) return urlMatch[1].toLowerCase();
    return trimmed.toLowerCase();
  }

  async function handleAddTrader(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setFormSubmitting(true);
    const ok = await addTrader({
      address: parsePolymarketAddress(formAddress),
      label: formLabel.trim(),
      allocationUsd: parseFloat(formAllocation),
      copyRatio: parseFloat(formRatio),
      mode: formMode,
      enabled: true,
    });
    setFormSubmitting(false);
    if (!ok) {
      setFormError("Failed to add trader. Check the address and try again.");
      return;
    }
    setFormAddress("");
    setFormLabel("");
    setFormAllocation("50");
    setFormRatio("1.0");
    setFormMode("manual");
    setShowAddForm(false);
  }

  const pendingCount = pending.filter((t) => t.status === "pending").length;
  const openPositions = positions.filter((p) => p.netSize > 0.001).length;

  const cellStyle: React.CSSProperties = {
    padding: "8px 10px",
    textAlign: "right",
  };
  const leftCell: React.CSSProperties = { ...cellStyle, textAlign: "left" };
  const thStyle: React.CSSProperties = { ...cellStyle, fontWeight: 500 };
  const thLeft: React.CSSProperties = { ...thStyle, textAlign: "left" };

  return (
    <div>
      {/* Back + header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{bot.name}</div>
        <span className="badge">{bot.strategy}</span>
        <div
          className="status-dot"
          style={{ background: online ? "#4caf50" : "#ff3b30", marginLeft: 4 }}
        />
        {!online && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            ⚠ Bot offline — start copy-trader on :3004
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Traders Tracked</div>
          <div className="balance-big">
            {traders.filter((t) => t.enabled).length}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Pending Approvals</div>
          <div
            className="balance-big"
            style={{ color: pendingCount > 0 ? "#ff9500" : "inherit" }}
          >
            {pendingCount}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Realized PnL</div>
          <div className={`balance-big ${pnlClass(totalRealizedPnl)}`}>
            {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Open Positions</div>
          <div className="balance-big">{openPositions}</div>
        </div>
      </div>

      {loading && <p className="offline">Loading copy-trader data…</p>}

      {/* ── Pending Approvals ── */}
      {pending.filter((t) => t.status === "pending").length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div
            className="section-label"
            style={{ marginBottom: 10, color: "#ff9500" }}
          >
            ⏳ Pending Approvals ({pendingCount})
          </div>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Trader",
                    "Market",
                    "Outcome",
                    "Side",
                    "Our Size",
                    "~USD",
                    "Price",
                    "Actions",
                  ].map((h) => (
                    <th
                      key={h}
                      style={
                        h === "Trader" || h === "Market" ? thLeft : thStyle
                      }
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pending
                  .filter((t) => t.status === "pending")
                  .map((t: PendingTrade) => (
                    <tr
                      key={t.id}
                      style={{ borderTop: "1px solid var(--border)" }}
                    >
                      <td style={leftCell}>{t.traderLabel}</td>
                      <td
                        style={{
                          ...leftCell,
                          maxWidth: 200,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.marketTitle}
                      >
                        {t.marketTitle}
                      </td>
                      <td style={cellStyle}>{t.outcome}</td>
                      <td
                        style={{
                          ...cellStyle,
                          color: t.side === "BUY" ? "#4caf50" : "#ff6b6b",
                          fontWeight: 600,
                        }}
                      >
                        {t.side}
                      </td>
                      <td style={cellStyle}>{t.ourTargetShares.toFixed(2)}</td>
                      <td style={cellStyle}>${t.ourTargetUsd.toFixed(2)}</td>
                      <td style={cellStyle}>{t.suggestedPrice.toFixed(4)}</td>
                      <td style={{ ...cellStyle, display: "flex", gap: 6 }}>
                        <button
                          className="btn-primary"
                          style={{ padding: "3px 10px", fontSize: 11 }}
                          onClick={() => void approveTrade(t.id)}
                        >
                          Approve
                        </button>
                        <button
                          style={{
                            padding: "3px 10px",
                            fontSize: 11,
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            color: "var(--text)",
                            cursor: "pointer",
                          }}
                          onClick={() => void rejectTrade(t.id)}
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Recent trade history (last 20 non-pending) ── */}
      {pending.filter((t) => t.status !== "pending").length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="section-label" style={{ marginBottom: 10 }}>
            Recent Copy Trades
          </div>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 11,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Trader",
                    "Market",
                    "Side",
                    "Size",
                    "Price",
                    "Status",
                    "Time",
                  ].map((h) => (
                    <th
                      key={h}
                      style={
                        h === "Trader" || h === "Market" ? thLeft : thStyle
                      }
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pending
                  .filter((t) => t.status !== "pending")
                  .slice(0, 20)
                  .map((t: PendingTrade) => (
                    <tr
                      key={t.id}
                      style={{ borderTop: "1px solid var(--border)" }}
                    >
                      <td style={leftCell}>{t.traderLabel}</td>
                      <td
                        style={{
                          ...leftCell,
                          maxWidth: 180,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.marketTitle}
                      >
                        {t.marketTitle}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          color: t.side === "BUY" ? "#4caf50" : "#ff6b6b",
                        }}
                      >
                        {t.side}
                      </td>
                      <td style={cellStyle}>
                        {(t.executedSize ?? t.ourTargetShares).toFixed(2)}
                      </td>
                      <td style={cellStyle}>
                        {t.executionPrice != null
                          ? t.executionPrice.toFixed(4)
                          : t.suggestedPrice.toFixed(4)}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          color:
                            t.status === "executed"
                              ? "#4caf50"
                              : t.status === "failed"
                                ? "#ff3b30"
                                : "var(--text-secondary)",
                        }}
                      >
                        {t.status}
                      </td>
                      <td
                        style={{ ...cellStyle, color: "var(--text-secondary)" }}
                      >
                        {new Date(t.detectedAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Our Positions ── */}
      {positions.filter((p) => p.netSize > 0.001).length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="section-label" style={{ marginBottom: 10 }}>
            Our Copy Positions
          </div>
          <div style={{ overflowX: "auto" }}>
            {(() => {
              // Build label → address map for snapshot lookups
              const traderByLabel = Object.fromEntries(
                traders.map((t) => [t.label, t]),
              );

              return (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                    background: "var(--card)",
                    borderRadius: 10,
                    overflow: "hidden",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: "var(--background)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <th style={thLeft} rowSpan={2}>
                        Market / Outcome
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          borderBottom: "1px solid var(--border)",
                        }}
                        colSpan={4}
                      >
                        Ours
                      </th>
                      <th
                        style={{
                          ...thStyle,
                          borderBottom: "1px solid var(--border)",
                          borderLeft: "2px solid var(--border)",
                        }}
                        colSpan={3}
                      >
                        Trader
                      </th>
                    </tr>
                    <tr
                      style={{
                        background: "var(--background)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {["Size", "Capital", "Unreal PnL", "Real PnL"].map(
                        (h) => (
                          <th key={h} style={thStyle}>
                            {h}
                          </th>
                        ),
                      )}
                      {["Size", "Capital", "Unreal PnL"].map((h, i) => (
                        <th
                          key={h}
                          style={{
                            ...thStyle,
                            ...(i === 0
                              ? { borderLeft: "2px solid var(--border)" }
                              : {}),
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions
                      .filter((p) => p.netSize > 0.001)
                      .map((p: CopyInventoryPosition) => {
                        // Find this trader's snapshot for this tokenId
                        const trader = traderByLabel[p.sourceTrader];
                        const snapshot: TraderDataPosition | undefined = trader
                          ? (traderSnapshots[trader.address] ?? []).find(
                              (s) => s.asset === p.tokenId,
                            )
                          : undefined;

                        const ourCapital = p.netSize * p.avgPrice;
                        const curPrice = snapshot
                          ? parseFloat(snapshot.curPrice)
                          : null;
                        const ourUnrealPnl =
                          curPrice != null
                            ? p.netSize * (curPrice - p.avgPrice)
                            : null;

                        const traderSize = snapshot
                          ? parseFloat(snapshot.size)
                          : null;
                        const traderAvgPrice = snapshot
                          ? parseFloat(snapshot.avgPrice)
                          : null;
                        const traderCapital =
                          traderSize != null && traderAvgPrice != null
                            ? traderSize * traderAvgPrice
                            : null;
                        const traderUnrealPnl =
                          curPrice != null &&
                          traderSize != null &&
                          traderAvgPrice != null
                            ? traderSize * (curPrice - traderAvgPrice)
                            : null;

                        const marketTitle =
                          snapshot?.title ?? `…${p.tokenId.slice(-8)}`;
                        const outcome = snapshot?.outcome ?? "—";

                        const pnlColor = (v: number | null) =>
                          v == null
                            ? "inherit"
                            : v >= 0
                              ? "#4caf50"
                              : "#ff6b6b";

                        return (
                          <tr
                            key={p.tokenId}
                            style={{ borderTop: "1px solid var(--border)" }}
                          >
                            <td style={leftCell}>
                              <div
                                title={p.tokenId}
                                style={{
                                  fontWeight: 600,
                                  maxWidth: 220,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {marketTitle}
                              </div>
                              <div
                                style={{
                                  color: "var(--text-secondary)",
                                  fontSize: 11,
                                }}
                              >
                                {outcome} · {p.sourceTrader}
                              </div>
                            </td>
                            {/* Ours */}
                            <td style={cellStyle}>{p.netSize.toFixed(2)}</td>
                            <td style={cellStyle}>${ourCapital.toFixed(2)}</td>
                            <td
                              style={{
                                ...cellStyle,
                                color: pnlColor(ourUnrealPnl),
                              }}
                            >
                              {ourUnrealPnl != null
                                ? `${ourUnrealPnl >= 0 ? "+" : ""}$${ourUnrealPnl.toFixed(2)}`
                                : "—"}
                            </td>
                            <td
                              style={{
                                ...cellStyle,
                                color: pnlColor(p.realizedPnl),
                              }}
                            >
                              {p.realizedPnl >= 0 ? "+" : ""}$
                              {p.realizedPnl.toFixed(2)}
                            </td>
                            {/* Trader */}
                            <td
                              style={{
                                ...cellStyle,
                                borderLeft: "2px solid var(--border)",
                              }}
                            >
                              {traderSize != null ? traderSize.toFixed(2) : "—"}
                            </td>
                            <td style={cellStyle}>
                              {traderCapital != null
                                ? `$${traderCapital.toFixed(2)}`
                                : "—"}
                            </td>
                            <td
                              style={{
                                ...cellStyle,
                                color: pnlColor(traderUnrealPnl),
                              }}
                            >
                              {traderUnrealPnl != null
                                ? `${traderUnrealPnl >= 0 ? "+" : ""}$${traderUnrealPnl.toFixed(2)}`
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Traders Management ── */}
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <div className="section-label">Tracked Traders</div>
          <button
            className="btn-primary"
            style={{ fontSize: 12, padding: "5px 14px" }}
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? "Cancel" : "+ Add Trader"}
          </button>
        </div>

        {showAddForm && (
          <form
            onSubmit={(e) => void handleAddTrader(e)}
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 16,
              marginBottom: 16,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Polymarket Profile URL or Wallet Address
                <br />
                <span style={{ fontSize: 11, opacity: 0.7 }}>
                  Go to polymarket.com → find a trader → copy the profile URL
                  (e.g. polymarket.com/profile/0x…) or paste just the 0x address
                </span>
              </label>
              <input
                required
                value={formAddress}
                onChange={(e) => setFormAddress(e.target.value)}
                placeholder="https://polymarket.com/profile/0x… or 0x…"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 10px",
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Label
              </label>
              <input
                required
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="e.g. Top Trader"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 10px",
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Allocation (USD)
              </label>
              <input
                required
                type="number"
                min="1"
                step="1"
                value={formAllocation}
                onChange={(e) => setFormAllocation(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 10px",
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Copy Ratio (0.01 – 1.0)
              </label>
              <input
                required
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                value={formRatio}
                onChange={(e) => setFormRatio(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 10px",
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Approval Mode
              </label>
              <select
                value={formMode}
                onChange={(e) =>
                  setFormMode(e.target.value as CopyTrader["mode"])
                }
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 10px",
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text)",
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              >
                <option value="manual">Manual (dashboard approval)</option>
                <option value="auto">Auto (instant execution)</option>
                <option value="orchestrator">Orchestrator (AI decides)</option>
              </select>
            </div>
            {formError && (
              <div
                style={{ gridColumn: "1 / -1", color: "#ff3b30", fontSize: 12 }}
              >
                {formError}
              </div>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="submit"
                className="btn-primary"
                disabled={formSubmitting}
                style={{ fontSize: 13, padding: "7px 20px" }}
              >
                {formSubmitting ? "Adding…" : "Add Trader"}
              </button>
            </div>
          </form>
        )}

        {traders.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No traders tracked yet. Add a Polymarket profile to start copying.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Label",
                    "Address",
                    "Allocation",
                    "Ratio",
                    "Mode",
                    "Status",
                    "Actions",
                  ].map((h) => (
                    <th
                      key={h}
                      style={
                        h === "Label" || h === "Address" ? thLeft : thStyle
                      }
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {traders.map((t: CopyTrader) => (
                  <tr
                    key={t.address}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td style={leftCell}>{t.label}</td>
                    <td
                      style={{
                        ...leftCell,
                        fontFamily: "monospace",
                        fontSize: 11,
                      }}
                      title={t.address}
                    >
                      {t.address.slice(0, 10)}…{t.address.slice(-6)}
                    </td>
                    <td style={cellStyle}>${t.allocationUsd.toFixed(0)}</td>
                    <td style={cellStyle}>{(t.copyRatio * 100).toFixed(0)}%</td>
                    <td style={cellStyle}>{t.mode}</td>
                    <td
                      style={{
                        ...cellStyle,
                        color: t.enabled ? "#4caf50" : "var(--text-secondary)",
                      }}
                    >
                      {t.enabled ? "active" : "paused"}
                    </td>
                    <td style={{ ...cellStyle, display: "flex", gap: 6 }}>
                      <button
                        style={{
                          padding: "3px 8px",
                          fontSize: 11,
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          color: "var(--text)",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          void updateTrader(t.address, { enabled: !t.enabled })
                        }
                      >
                        {t.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        style={{
                          padding: "3px 8px",
                          fontSize: 11,
                          background: "transparent",
                          border: "1px solid #ff3b30",
                          borderRadius: 6,
                          color: "#ff3b30",
                          cursor: "pointer",
                        }}
                        onClick={() => void removeTrader(t.address)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Chat */}
      <div style={{ marginTop: 32 }}>
        <OpenClawChat botId={Number(bot.id)} />
      </div>
    </div>
  );
}

// ── In-Market Arb View ────────────────────────────────────────────────────────
function InMarketArbView({
  bot,
  onBack,
}: {
  bot: BotSummary;
  onBack: () => void;
}) {
  const { data, loading, error } = useInMarketArb();
  const { pairs, totalRealizedPnl, signals, scannedAt, metrics } = data;
  const equity = metrics?.equity ?? bot.equity;
  const openPairs = pairs.filter(
    (p) => p.status === "pending" || p.status === "partial",
  ).length;

  const statusBadgeColor = (s: string) => {
    if (s === "filled") return "#4caf50";
    if (s === "cancelled") return "#ff6b6b";
    if (s === "partial") return "#ff9800";
    return "var(--text-secondary)";
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{bot.name}</div>
        <span className="badge">{bot.strategy}</span>
        <div
          className="status-dot"
          style={{ background: statusColor(bot.status), marginLeft: 4 }}
        />
      </div>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Allocated Equity</div>
          <div className="balance-big">${equity.toFixed(2)}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Open Pairs</div>
          <div className="balance-big">{openPairs}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Realized PnL</div>
          <div className={`balance-big ${pnlClass(totalRealizedPnl)}`}>
            {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Utilization</div>
          <div className="balance-big">
            {(metrics?.utilization ?? 0).toFixed(1)}%
          </div>
        </div>
      </div>

      {loading && <p className="offline">Loading data…</p>}
      {error && <p className="offline">⚠ Bot offline — {error}</p>}

      {/* Scan Results */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Latest Scan Results
          {scannedAt && (
            <span
              style={{
                fontWeight: 400,
                marginLeft: 8,
                color: "var(--text-secondary)",
                fontSize: 11,
              }}
            >
              scanned {new Date(scannedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {signals.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No profitable signals in last scan.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Market",
                    "YES Ask",
                    "NO Ask",
                    "Net Spread",
                    "Vol (USD)",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: h === "Market" ? "left" : "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr
                    key={s.marketId}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={s.marketQuestion}
                    >
                      {s.marketQuestion}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {s.yesEntryPrice.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {s.noEntryPrice.toFixed(4)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "#4caf50",
                      }}
                    >
                      +{(s.netSpread * 100).toFixed(2)}%
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      ${s.profitableVolumeUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Active Pairs */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Active Pairs
        </div>
        {pairs.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No pairs tracked yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Market",
                    "YES Price",
                    "NO Price",
                    "Size (USD)",
                    "Status",
                    "PnL",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: h === "Market" ? "left" : "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr
                    key={p.id}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={p.marketQuestion}
                    >
                      {p.marketQuestion}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.yesPrice.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.noPrice.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      ${p.sizeUsd.toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: statusBadgeColor(p.status),
                      }}
                    >
                      {p.status}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color:
                          (p.realizedPnl ?? 0) >= 0 ? "#4caf50" : "#ff6b6b",
                      }}
                    >
                      {p.realizedPnl != null
                        ? `${p.realizedPnl >= 0 ? "+" : ""}$${p.realizedPnl.toFixed(4)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Config */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="section-label" style={{ marginBottom: 12 }}>
          Configuration
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            fontSize: 13,
          }}
        >
          {[
            {
              label: "Fee Threshold",
              value: `${(0.002 * 100).toFixed(1)}%`,
              hint: "Min net spread required",
            },
            {
              label: "Max Position USD",
              value: "$50",
              hint: "Per market pair",
            },
            {
              label: "Max Concurrent",
              value: "10",
              hint: "Markets scanned simultaneously",
            },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                background: "var(--background)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginBottom: 4,
                }}
              >
                {item.label}
              </div>
              <div style={{ fontWeight: 600 }}>{item.value}</div>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginTop: 2,
                }}
              >
                {item.hint}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <OpenClawChat botId={Number(bot.id)} />
      </div>
    </div>
  );
}

// ── Resolution Lag View ───────────────────────────────────────────────────────
function ResolutionLagView({
  bot,
  onBack,
}: {
  bot: BotSummary;
  onBack: () => void;
}) {
  const { data, loading, error } = useResolutionLag();
  const { positions, totalRealizedPnl, opportunities, scannedAt, metrics } =
    data;
  const equity = metrics?.equity ?? bot.equity;
  const openPositions = positions.filter((p) => p.status === "open").length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{bot.name}</div>
        <span className="badge">{bot.strategy}</span>
        <div
          className="status-dot"
          style={{ background: statusColor(bot.status), marginLeft: 4 }}
        />
      </div>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Allocated Equity</div>
          <div className="balance-big">${equity.toFixed(2)}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Open Positions</div>
          <div className="balance-big">{openPositions}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Realized PnL</div>
          <div className={`balance-big ${pnlClass(totalRealizedPnl)}`}>
            {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Opportunities Found</div>
          <div className="balance-big">{opportunities.length}</div>
        </div>
      </div>

      {loading && <p className="offline">Loading data…</p>}
      {error && <p className="offline">⚠ Bot offline — {error}</p>}

      {/* Opportunities */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Resolution Opportunities
          {scannedAt && (
            <span
              style={{
                fontWeight: 400,
                marginLeft: 8,
                color: "var(--text-secondary)",
                fontSize: 11,
              }}
            >
              scanned {new Date(scannedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {opportunities.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No opportunities found in last scan.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {["Market", "Outcome", "CLOB Ask", "Yield"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: h === "Market" ? "left" : "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {opportunities.map((o) => (
                  <tr
                    key={o.market.id}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={o.market.question}
                    >
                      {o.market.question}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color:
                          o.market.gammaOutcome === "YES"
                            ? "#4caf50"
                            : "#ff6b6b",
                      }}
                    >
                      {o.market.gammaOutcome}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {o.currentAsk.toFixed(4)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "#4caf50",
                      }}
                    >
                      +{(o.expectedYield * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Positions */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Positions
        </div>
        {positions.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No positions held yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {[
                    "Market",
                    "Bought At",
                    "Size",
                    "Cost",
                    "Exp. Yield",
                    "Status",
                    "PnL",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: h === "Market" ? "left" : "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr
                    key={p.id}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 240,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={p.marketQuestion}
                    >
                      {p.marketQuestion}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.boughtAt.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.size.toFixed(2)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      ${p.costBasis.toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: "#4caf50",
                      }}
                    >
                      +{(p.expectedYield * 100).toFixed(1)}%
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color:
                          p.status === "resolved"
                            ? "#4caf50"
                            : p.status === "expired"
                              ? "#ff6b6b"
                              : "var(--text-secondary)",
                      }}
                    >
                      {p.status}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color:
                          (p.realizedPnl ?? 0) >= 0 ? "#4caf50" : "#ff6b6b",
                      }}
                    >
                      {p.realizedPnl != null
                        ? `${p.realizedPnl >= 0 ? "+" : ""}$${p.realizedPnl.toFixed(4)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Config */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="section-label" style={{ marginBottom: 12 }}>
          Configuration
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            fontSize: 13,
          }}
        >
          {[
            {
              label: "Min Yield",
              value: "0.5%",
              hint: "Minimum discount to act",
            },
            { label: "Max Position USD", value: "$100", hint: "Per market" },
            {
              label: "Max Open Positions",
              value: "20",
              hint: "Concurrent positions cap",
            },
            {
              label: "Monitor Interval",
              value: "5 min",
              hint: "Scan frequency",
            },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                background: "var(--background)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginBottom: 4,
                }}
              >
                {item.label}
              </div>
              <div style={{ fontWeight: 600 }}>{item.value}</div>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginTop: 2,
                }}
              >
                {item.hint}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <OpenClawChat botId={Number(bot.id)} />
      </div>
    </div>
  );
}

// ── Microstructure View ───────────────────────────────────────────────────────
function MicrostructureView({
  bot,
  onBack,
}: {
  bot: BotSummary;
  onBack: () => void;
}) {
  const { data, loading, error } = useMicrostructure();
  const { positions, totalRealizedPnl, screenedMarkets, metrics } = data;
  const equity = metrics?.equity ?? bot.equity;
  const activeBids = positions.filter((p) => p.bidOrderId !== null).length;
  const heldShares = positions.reduce((s, p) => s + p.heldShares, 0);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text)",
            cursor: "pointer",
            padding: "6px 14px",
            fontSize: 13,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{bot.name}</div>
        <span className="badge">{bot.strategy}</span>
        <div
          className="status-dot"
          style={{ background: statusColor(bot.status), marginLeft: 4 }}
        />
      </div>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Allocated Equity</div>
          <div className="balance-big">${equity.toFixed(2)}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Active Bids</div>
          <div className="balance-big">{activeBids}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Screened Markets</div>
          <div className="balance-big">{screenedMarkets.length}</div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Realized PnL</div>
          <div className={`balance-big ${pnlClass(totalRealizedPnl)}`}>
            {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(4)}
          </div>
        </div>
      </div>

      {loading && <p className="offline">Loading data…</p>}
      {error && <p className="offline">⚠ Bot offline — {error}</p>}

      {/* Active Positions */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Active Positions
          {heldShares > 0 && (
            <span
              style={{
                fontWeight: 400,
                marginLeft: 8,
                color: "var(--text-secondary)",
                fontSize: 11,
              }}
            >
              {heldShares.toFixed(2)} shares held
            </span>
          )}
        </div>
        {positions.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No active positions — waiting for fills.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {["Market", "Bid", "Ask", "Held", "Days Left", "PnL"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 10px",
                          textAlign: h === "Market" ? "left" : "right",
                          fontWeight: 500,
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr
                    key={p.marketId}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={p.marketQuestion}
                    >
                      {p.marketQuestion}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: p.bidOrderId
                          ? "#4caf50"
                          : "var(--text-secondary)",
                      }}
                    >
                      {p.bidOrderId ? p.bidPrice.toFixed(4) : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: p.askOrderId
                          ? "#ff6b6b"
                          : "var(--text-secondary)",
                      }}
                    >
                      {p.askOrderId ? p.askPrice.toFixed(4) : "—"}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.heldShares.toFixed(2)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {p.daysToExpiry}d
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: p.realizedPnl >= 0 ? "#4caf50" : "#ff6b6b",
                      }}
                    >
                      {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Screened Markets */}
      <div style={{ marginBottom: 32 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Screened Markets
        </div>
        {screenedMarkets.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            No screened markets yet — next screen in up to 30 min.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                background: "var(--card)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--background)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {["Market", "Best Ask", "Days to Expiry"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "8px 10px",
                        textAlign: h === "Market" ? "left" : "right",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {screenedMarkets.map((m) => (
                  <tr
                    key={m.id}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        maxWidth: 300,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={m.question}
                    >
                      {m.question}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {m.bestAsk.toFixed(4)}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right" }}>
                      {m.daysToExpiry}d
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Config */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="section-label" style={{ marginBottom: 12 }}>
          Configuration
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            fontSize: 13,
          }}
        >
          {[
            {
              label: "Max Ask Price",
              value: "0.3¢",
              hint: "Filter ceiling for bids",
            },
            {
              label: "Min Days to Expiry",
              value: "90d",
              hint: "Only long-duration markets",
            },
            { label: "Max Markets", value: "200", hint: "Screened pool size" },
            {
              label: "USD Per Market",
              value: "$2",
              hint: "Capital per resting bid",
            },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                background: "var(--background)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginBottom: 4,
                }}
              >
                {item.label}
              </div>
              <div style={{ fontWeight: 600 }}>{item.value}</div>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  marginTop: 2,
                }}
              >
                {item.hint}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <OpenClawChat botId={Number(bot.id)} />
      </div>
    </div>
  );
}

// ── Portfolio section ─────────────────────────────────────────────────────────
function PortfolioSection({
  onSelectBot,
}: {
  onSelectBot: (bot: BotSummary) => void;
}) {
  const { portfolio, loading, error } = usePortfolio();

  return (
    <div>
      <div
        className="section-label"
        style={{ marginTop: 32, marginBottom: 12 }}
      >
        Bot Portfolio
      </div>

      {loading ? (
        <p className="offline">Loading portfolio…</p>
      ) : error ? (
        <p className="offline">
          ⚠ Orchestrator offline — start orchestrator on :3002
        </p>
      ) : portfolio ? (
        <>
          <div className="grid-2">
            <div className="card" style={{ textAlign: "center" }}>
              <div className="balance-label">Total Equity</div>
              <div className="balance-big">
                ${portfolio.totalEquity.toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ textAlign: "center" }}>
              <div className="balance-label">Total PnL</div>
              <div className={`balance-big ${pnlClass(portfolio.totalPnl)}`}>
                {portfolio.totalPnl >= 0 ? "+" : ""}$
                {portfolio.totalPnl.toFixed(2)}
              </div>
            </div>
          </div>
          <div className="bot-grid">
            {portfolio.bots.map((bot) => (
              <BotCard
                key={bot.id}
                bot={bot}
                onClick={() => onSelectBot(bot)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [selectedBot, setSelectedBot] = useState<BotSummary | null>(null);
  const { address, isConnected } = useAccount();
  const {
    user,
    loading: userLoading,
    balance,
    balanceLoading,
    saveFunderAddress,
    startBots,
    stopBots,
    convertFunds,
    setAutonomousMode,
    refreshBalance,
    withdrawFunds,
  } = useUser(isConnected ? address : undefined);

  // Show onboarding if connected but setup not complete
  const showOnboarding =
    isConnected && !userLoading && user !== null && !user.botsRunning;

  const [withdrawing, setWithdrawing] = React.useState(false);
  const [withdrawResult, setWithdrawResult] = React.useState<{
    withdrawTxHash: string;
    amountWithdrawn: string;
  } | null>(null);
  const [withdrawError, setWithdrawError] = React.useState<string | null>(null);
  const [withdrawAmount, setWithdrawAmount] = React.useState("");
  const [withdrawStopBots, setWithdrawStopBots] = React.useState(true);
  const [showAdmin, setShowAdmin] = React.useState(false);

  const handleWithdraw = async () => {
    setWithdrawing(true);
    setWithdrawError(null);
    setWithdrawResult(null);
    try {
      const result = await withdrawFunds({
        stopBots: withdrawStopBots,
        amountUsdt: withdrawAmount || undefined,
      });
      setWithdrawResult(result);
    } catch (err) {
      setWithdrawError(err instanceof Error ? err.message : String(err));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <>
      <div className="header">
        <div className="logo">
          🤖 <span>OpenClaw</span> Agent Dashboard
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Polygon Mainnet
        </div>
      </div>

      {selectedBot ? (
        selectedBot.id === "3" ? (
          <CopyTraderView
            bot={selectedBot}
            onBack={() => setSelectedBot(null)}
          />
        ) : selectedBot.id === "4" ? (
          <InMarketArbView
            bot={selectedBot}
            onBack={() => setSelectedBot(null)}
          />
        ) : selectedBot.id === "5" ? (
          <ResolutionLagView
            bot={selectedBot}
            onBack={() => setSelectedBot(null)}
          />
        ) : selectedBot.id === "6" ? (
          <MicrostructureView
            bot={selectedBot}
            onBack={() => setSelectedBot(null)}
          />
        ) : (
          <BotDetailView
            bot={selectedBot}
            onBack={() => setSelectedBot(null)}
          />
        )
      ) : (
        <>
          <WalletSection />
          {showOnboarding && user && (
            <div style={{ padding: "0 24px" }}>
              <UserOnboarding
                user={user}
                balance={balance}
                onSaveFunderAddress={saveFunderAddress}
                onStartBots={startBots}
                onConvertFunds={convertFunds}
                onSetAutonomousMode={setAutonomousMode}
              />
            </div>
          )}
          {/* Agent wallet balance card — shown after onboarding */}
          {isConnected && user?.botsRunning && (
            <div style={{ padding: "0 24px", marginBottom: 16 }}>
              <div className="card">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 12,
                  }}
                >
                  <div className="section-label" style={{ margin: 0 }}>
                    Agent Wallet
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 12, padding: "4px 10px" }}
                    onClick={refreshBalance}
                    disabled={balanceLoading}
                  >
                    {balanceLoading ? "…" : "Refresh"}
                  </button>
                </div>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <div>
                    <div className="balance-label">USDT</div>
                    <div className="balance-big">
                      {balance ? parseFloat(balance.usdt).toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="balance-label">USDC.e</div>
                    <div className="balance-big">
                      {balance ? parseFloat(balance.usdce).toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="balance-label">POL (gas)</div>
                    <div className="balance-big">
                      {balance && balance.nativePol !== "0"
                        ? (Number(balance.nativePol) / 1e18).toFixed(4)
                        : "0"}
                    </div>
                  </div>
                </div>
                {balance && parseFloat(balance.usdt) >= 1 && (
                  <div
                    style={{
                      marginTop: 12,
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <button
                      className="btn-primary"
                      style={{ fontSize: 13 }}
                      onClick={() =>
                        convertFunds().then(() => refreshBalance())
                      }
                    >
                      Convert USDT → USDC.e
                    </button>
                    <label
                      style={{
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={user?.autonomousMode ?? false}
                        onChange={(e) => setAutonomousMode(e.target.checked)}
                      />
                      Auto-convert
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}
          {/* Withdraw card — shown after onboarding */}
          {isConnected && user?.botsRunning && (
            <div style={{ padding: "0 24px", marginBottom: 16 }}>
              <div className="card">
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Withdraw to MetaMask
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    marginBottom: 12,
                    lineHeight: 1.5,
                  }}
                >
                  Converts USDC.e back to USDT via Uniswap, then sends USDT to
                  your connected MetaMask address on Polygon.
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: 10,
                  }}
                >
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Amount USDT (blank = all)"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 180,
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--background)",
                      color: "var(--text)",
                      fontSize: 13,
                    }}
                  />
                  <label
                    style={{
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={withdrawStopBots}
                      onChange={(e) => setWithdrawStopBots(e.target.checked)}
                    />
                    Stop bots first
                  </label>
                  <button
                    className="btn-primary"
                    style={{ background: "#c0392b", flexShrink: 0 }}
                    onClick={() => void handleWithdraw()}
                    disabled={withdrawing}
                  >
                    {withdrawing ? "Withdrawing…" : "Withdraw to MetaMask"}
                  </button>
                </div>
                {withdrawError && (
                  <p style={{ color: "#ff3b30", fontSize: 12, margin: 0 }}>
                    {withdrawError}
                  </p>
                )}
                {withdrawResult && (
                  <p style={{ color: "#4caf50", fontSize: 12, margin: 0 }}>
                    ✓ Withdrew {withdrawResult.amountWithdrawn} USDT —{" "}
                    <a
                      href={`https://polygonscan.com/tx/${withdrawResult.withdrawTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#4caf50" }}
                    >
                      View on PolygonScan ↗
                    </a>
                  </p>
                )}
              </div>
            </div>
          )}
          {/* Only show legacy portfolio/chat when user is not mid-onboarding */}
          {(!isConnected || !user || user.botsRunning) && (
            <>
              <PortfolioSection onSelectBot={setSelectedBot} />
              <div style={{ padding: "0 24px 24px" }}>
                <OpenClawChat />
              </div>
            </>
          )}
          {/* ── Admin footer ────────────────────────────────────────────────── */}
          <div
            style={{
              textAlign: "center",
              padding: "24px 0 16px",
              borderTop: "1px solid var(--border)",
              marginTop: 8,
            }}
          >
            <button
              onClick={() => setShowAdmin(true)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 12,
                cursor: "pointer",
                opacity: 0.4,
              }}
            >
              ⚙ Admin
            </button>
          </div>
        </>
      )}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
    </>
  );
}
