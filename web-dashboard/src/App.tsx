import React, { useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from "wagmi";
import { polygon } from "wagmi/chains";
import { parseUnits, formatUnits } from "viem";
import { useTreasury } from "./hooks/use-treasury";
import { usePortfolio, type BotSummary } from "./hooks/use-portfolio";
import {
  useBotDetail,
  type MarketPosition,
  type InventoryPosition,
} from "./hooks/use-bot-detail";
import { USDT_ADDRESS, USDT_DECIMALS } from "./config/wagmi";
import { BotConfigPanel } from "./components/BotConfigPanel";
import { OpenClawChat } from "./components/OpenClawChat";
import "./index.css";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

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
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const { data: usdtBalance } = useReadContract({
    address: USDT_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const wrongNetwork = isConnected && chainId !== polygon.id;

  return (
    <div>
      {wrongNetwork && (
        <div className="network-warning">
          <span>
            ⚠ You're on the wrong network. Switch to Polygon to fund the agent.
          </span>
          <button
            className="btn-primary"
            onClick={() => switchChain({ chainId: polygon.id })}
          >
            Switch to Polygon
          </button>
        </div>
      )}

      <div className="card card-accent">
        <div className="section-label">Your Wallet</div>
        {!isConnected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              Connect MetaMask to fund the OpenClaw agent
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
            <div>
              <div className="balance-label">USDT Balance (Polygon)</div>
              <div className="balance-big">
                {usdtBalance !== undefined
                  ? `${parseFloat(formatUnits(usdtBalance, USDT_DECIMALS)).toFixed(2)} USDT`
                  : "—"}
              </div>
              <div
                className="wallet-address"
                title="Click to copy"
                onClick={() => navigator.clipboard.writeText(address!)}
              >
                {abbrev(address!)} 📋
              </div>
            </div>
            <button className="btn-secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Treasury / Fund Agent section ────────────────────────────────────────────
function TreasurySection() {
  const { address, isConnected, chainId } = useAccount();
  const { treasury, loading, error } = useTreasury();
  const [amount, setAmount] = useState("");

  const {
    writeContract,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  const canFund =
    isConnected &&
    chainId === polygon.id &&
    !!treasury?.address &&
    !!amount &&
    parseFloat(amount) > 0;

  const handleFund = () => {
    if (!canFund || !treasury) return;
    reset();
    writeContract({
      address: USDT_ADDRESS,
      abi: [
        {
          type: "function",
          name: "transfer",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "nonpayable",
        },
      ] as const,
      functionName: "transfer",
      args: [
        treasury.address as `0x${string}`,
        parseUnits(amount, USDT_DECIMALS),
      ],
    });
  };

  return (
    <div className="card card-accent">
      <div className="section-label">OpenClaw Agent Wallet</div>

      {loading ? (
        <p className="offline">Loading treasury…</p>
      ) : error ? (
        <p className="offline">
          ⚠ Treasury service offline — start wdk-treasury on :3001
        </p>
      ) : treasury ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <div className="balance-label">USDT Balance</div>
              <div className="balance-big">
                {parseFloat(treasury.balanceUsdT).toFixed(2)} USDT
              </div>
              <div
                className="wallet-address"
                title="Click to copy"
                onClick={() => navigator.clipboard.writeText(treasury.address)}
              >
                {abbrev(treasury.address)} 📋
              </div>
            </div>
          </div>

          <div className="fund-form">
            <input
              className="fund-input"
              type="number"
              min="0"
              step="0.01"
              placeholder="Amount USDT"
              value={amount}
              onChange={(e) => {
                reset();
                setAmount(e.target.value);
              }}
            />
            <button
              className="btn-primary"
              disabled={!canFund || isPending || confirming}
              onClick={handleFund}
            >
              {isPending
                ? "Check MetaMask…"
                : confirming
                  ? "Confirming…"
                  : "Fund Agent"}
            </button>
          </div>

          {!isConnected && (
            <p className="tx-status">
              Connect your wallet above to fund the agent.
            </p>
          )}
          {isSuccess && hash && (
            <p className="tx-status">
              ✅ Funded!{" "}
              <a
                href={`https://polygonscan.com/tx/${hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on PolygonScan ↗
              </a>
            </p>
          )}
          {writeError && (
            <p className="tx-status" style={{ color: "var(--danger)" }}>
              ❌ {writeError.shortMessage ?? writeError.message}
            </p>
          )}
        </>
      ) : null}
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
      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Allocated Equity</div>
          <div className="balance-big">
            ${(allocatedEquity ?? bot.equity).toFixed(2)}
          </div>
        </div>
        <div className="card" style={{ textAlign: "center" }}>
          <div className="balance-label">Realized PnL</div>
          <div
            className={`balance-big ${pnlClass(totalRealizedPnl ?? bot.pnl)}`}
          >
            {(totalRealizedPnl ?? bot.pnl) >= 0 ? "+" : ""}$
            {(totalRealizedPnl ?? bot.pnl).toFixed(4)}
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
                  {["Token ID", "Net Size", "Avg Price", "Realized PnL"].map(
                    (h) => (
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
                    ),
                  )}
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
        <BotConfigPanel botId={Number(bot.id)} />
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
        <BotDetailView bot={selectedBot} onBack={() => setSelectedBot(null)} />
      ) : (
        <>
          <WalletSection />
          <TreasurySection />
          <PortfolioSection onSelectBot={setSelectedBot} />
        </>
      )}
    </>
  );
}
