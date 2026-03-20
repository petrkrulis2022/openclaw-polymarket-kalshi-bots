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
import { USDT_ADDRESS, USDT_DECIMALS } from "./config/wagmi";
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
function BotCard({ bot }: { bot: BotSummary }) {
  return (
    <div className="bot-card">
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

// ── Portfolio section ─────────────────────────────────────────────────────────
function PortfolioSection() {
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
              <BotCard key={bot.id} bot={bot} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
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

      <WalletSection />
      <TreasurySection />
      <PortfolioSection />
    </>
  );
}
