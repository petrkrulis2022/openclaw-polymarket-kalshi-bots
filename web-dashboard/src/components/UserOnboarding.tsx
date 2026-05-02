/**
 * UserOnboarding.tsx
 *
 * 3-step onboarding flow shown when a new user connects their wallet:
 *
 *  Step 1 — Fund bot wallet: display the server-generated EOA address, show
 *            live USDT balance on that address, and let the user continue once
 *            they've sent funds.
 *  Step 2 — Link Polymarket proxy wallet: the bot EOA needs to be connected on
 *            polymarket.com so a Gnosis Safe proxy wallet is created for it.
 *            The user copies that proxy wallet address here.
 *  Step 3 — Convert USDT → USDC.e and optionally enable autonomous mode.
 */

import React, { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { USDT_ADDRESS, USDT_DECIMALS } from "../config/wagmi";
import type { UserRecord, BotWalletBalance } from "../hooks/use-user";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

interface Props {
  user: UserRecord;
  balance: BotWalletBalance | null;
  onSaveFunderAddress: (funderAddress: string) => Promise<void>;
  onStartBots: () => Promise<void>;
  onConvertFunds: () => Promise<{
    usdtSwapped: string;
    usdceReceived: string;
    txHash: string;
  }>;
  onSetAutonomousMode: (enabled: boolean) => Promise<void>;
}

function abbrev(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

export function UserOnboarding({
  user,
  balance,
  onSaveFunderAddress,
  onStartBots,
  onConvertFunds,
  onSetAutonomousMode,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [funderAddress, setFunderAddress] = useState(user.funderAddress ?? "");
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertResult, setConvertResult] = useState<{
    usdtSwapped: string;
    usdceReceived: string;
    txHash: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendAmount, setSendAmount] = useState("");

  const {
    writeContract,
    data: sendTxHash,
    isPending: isSendPending,
    error: sendTxError,
    reset: resetSendTx,
  } = useWriteContract();

  const { isLoading: isSendConfirming, isSuccess: isSendConfirmed } =
    useWaitForTransactionReceipt({ hash: sendTxHash });

  const handleSendUsdt = () => {
    const amount = parseFloat(sendAmount);
    if (!botAddr || isNaN(amount) || amount <= 0) return;
    resetSendTx();
    writeContract({
      address: USDT_ADDRESS,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [botAddr as `0x${string}`, parseUnits(sendAmount, USDT_DECIMALS)],
    });
  };

  const botAddr = user.botWalletAddress ?? "";
  const usdtBalance = balance ? parseFloat(balance.usdt) : 0;
  const usdceBalance = balance ? parseFloat(balance.usdce) : 0;
  const hasFunds = usdtBalance > 0 || usdceBalance > 0;

  const handleSaveFunderAddress = async () => {
    const addr = funderAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setError("Enter a valid 0x-prefixed Ethereum address (42 chars).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveFunderAddress(addr);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleStartBots = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStartBots();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleConvert = async () => {
    setConverting(true);
    setError(null);
    setConvertResult(null);
    try {
      const result = await onConvertFunds();
      setConvertResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="card card-accent" style={{ marginBottom: 24 }}>
      <div className="section-label">Setup — Your OpenClaw Bot</div>

      {/* Step indicators */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 20,
          fontSize: 13,
          color: "var(--text-secondary)",
        }}
      >
        {([1, 2, 3] as const).map((s) => (
          <span
            key={s}
            style={{
              padding: "4px 12px",
              borderRadius: 12,
              background: step === s ? "var(--accent)" : "var(--surface)",
              color: step === s ? "#fff" : "var(--text-secondary)",
              fontWeight: step === s ? 600 : 400,
              cursor: step > s ? "pointer" : "default",
            }}
            onClick={() => step > s && setStep(s)}
          >
            {s === 1 ? "Fund" : s === 2 ? "Proxy Wallet" : "Activate"}
          </span>
        ))}
      </div>

      {/* Step 1 — Fund bot wallet */}
      {step === 1 && (
        <div>
          <p style={{ marginBottom: 12, lineHeight: 1.6 }}>
            OpenClaw generated a dedicated trading wallet for you. Send{" "}
            <strong>USDT on Polygon</strong> to this address — it will be
            automatically converted to USDC.e for trading:
          </p>

          <div
            style={{
              background: "var(--surface)",
              borderRadius: 8,
              padding: "12px 16px",
              fontFamily: "monospace",
              fontSize: 14,
              wordBreak: "break-all",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span>{botAddr}</span>
            <button
              className="btn-secondary"
              style={{ flexShrink: 0, padding: "4px 10px", fontSize: 12 }}
              onClick={() => navigator.clipboard.writeText(botAddr)}
            >
              Copy
            </button>
          </div>

          {/* MetaMask send button */}
          <div
            style={{
              background: "var(--surface)",
              borderRadius: 8,
              padding: "14px 16px",
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
              Send USDT via MetaMask
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <input
                type="number"
                min="0"
                step="any"
                placeholder="Amount (USDT)"
                value={sendAmount}
                onChange={(e) => {
                  setSendAmount(e.target.value);
                  resetSendTx();
                }}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border, #333)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 14,
                }}
              />
              <button
                className="btn-primary"
                style={{ flexShrink: 0 }}
                onClick={handleSendUsdt}
                disabled={
                  !sendAmount ||
                  parseFloat(sendAmount) <= 0 ||
                  isSendPending ||
                  isSendConfirming
                }
              >
                {isSendPending
                  ? "Confirm in MetaMask…"
                  : isSendConfirming
                    ? "Confirming…"
                    : "Send USDT"}
              </button>
            </div>
            {sendTxError && (
              <p style={{ color: "#f44336", fontSize: 12, margin: 0 }}>
                {sendTxError.message.split("\n")[0]}
              </p>
            )}
            {isSendConfirmed && sendTxHash && (
              <p style={{ color: "#4caf50", fontSize: 12, margin: 0 }}>
                ✓ Sent!{" "}
                <a
                  href={`https://polygonscan.com/tx/${sendTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on PolygonScan ↗
                </a>
              </p>
            )}
          </div>

          {/* Live balance display */}
          {balance ? (
            <div
              style={{
                background: "var(--surface)",
                borderRadius: 8,
                padding: "10px 14px",
                fontSize: 13,
                marginBottom: 16,
                display: "flex",
                gap: 24,
              }}
            >
              <div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginBottom: 2,
                  }}
                >
                  USDT
                </div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>
                  {usdtBalance.toFixed(2)}
                </div>
              </div>
              <div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginBottom: 2,
                  }}
                >
                  USDC.e
                </div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>
                  {usdceBalance.toFixed(2)}
                </div>
              </div>
              <div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginBottom: 2,
                  }}
                >
                  POL (gas)
                </div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>
                  {balance.nativePol !== "0"
                    ? (Number(balance.nativePol) / 1e18).toFixed(4)
                    : "0"}
                </div>
              </div>
            </div>
          ) : (
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 16,
              }}
            >
              Checking balance… (Token: USDT · Network: Polygon)
            </p>
          )}

          <button
            className="btn-primary"
            onClick={() => setStep(2)}
            disabled={!hasFunds}
            title={!hasFunds ? "Send USDT to continue" : undefined}
          >
            {hasFunds ? "Funds received → Next" : "Waiting for USDT…"}
          </button>
          {!hasFunds && (
            <p
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginTop: 8,
              }}
            >
              Balance updates every 30 s automatically.
            </p>
          )}
        </div>
      )}

      {/* Step 2 — Link Polymarket proxy wallet */}
      {step === 2 && (
        <div>
          <p style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Polymarket uses a <strong>proxy wallet</strong> (Gnosis Safe) for
            each connected address. Your bot EOA{" "}
            <strong>{abbrev(botAddr)}</strong> needs to be connected on
            Polymarket so it gets one. Then paste the proxy wallet address below
            — this is used to sign orders on-chain.
          </p>

          <ol style={{ paddingLeft: 20, lineHeight: 2, marginBottom: 16 }}>
            <li>
              Go to{" "}
              <a
                href="https://polymarket.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                polymarket.com
              </a>{" "}
              and connect MetaMask with your bot address{" "}
              <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                {abbrev(botAddr)}
              </span>
              . (Import it first if needed.)
            </li>
            <li>
              Accept the sign-in prompt — Polymarket creates a proxy wallet for
              your bot address automatically.
            </li>
            <li>
              Open{" "}
              <a
                href="https://polymarket.com/settings"
                target="_blank"
                rel="noopener noreferrer"
              >
                polymarket.com/settings
              </a>{" "}
              and copy your <strong>Proxy Wallet</strong> address (shown as
              "Your Account Address").
            </li>
          </ol>

          <div
            style={{
              background: "var(--surface)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <strong>Bot EOA address (to connect on Polymarket):</strong>
            <br />
            <span style={{ fontFamily: "monospace" }}>{botAddr}</span>{" "}
            <button
              className="btn-secondary"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={() => navigator.clipboard.writeText(botAddr)}
            >
              Copy
            </button>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Proxy Wallet Address (0x…)
            </label>
            <input
              type="text"
              className="input"
              placeholder="0x…"
              value={funderAddress}
              onChange={(e) => setFunderAddress(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          {error && (
            <p style={{ color: "#ff3b30", marginBottom: 12, fontSize: 13 }}>
              {error}
            </p>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn-primary"
              onClick={handleSaveFunderAddress}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Convert + autonomous */}
      {step === 3 && (
        <div>
          {user.hasApiKeys ? (
            <div>
              <p style={{ marginBottom: 16, color: "#4caf50" }}>
                ✓ Proxy wallet linked.
              </p>

              {/* Convert USDT → USDC.e */}
              {usdtBalance > 0 && (
                <div
                  style={{
                    background: "var(--surface)",
                    borderRadius: 8,
                    padding: "14px 16px",
                    marginBottom: 16,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    Convert USDT → USDC.e
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      marginBottom: 10,
                    }}
                  >
                    Your bot wallet has {usdtBalance.toFixed(2)} USDT. Convert
                    it to USDC.e via Uniswap V3 (stable 0.01% fee) so bots can
                    trade on Polymarket.
                  </p>
                  {convertResult ? (
                    <p style={{ color: "#4caf50", fontSize: 13 }}>
                      ✓ Swapped {convertResult.usdtSwapped} USDT →{" "}
                      {convertResult.usdceReceived} USDC.e &nbsp;
                      <a
                        href={`https://polygonscan.com/tx/${convertResult.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12 }}
                      >
                        View tx ↗
                      </a>
                    </p>
                  ) : (
                    <button
                      className="btn-primary"
                      onClick={handleConvert}
                      disabled={converting}
                    >
                      {converting
                        ? "Converting… (on-chain)"
                        : `Convert ${usdtBalance.toFixed(2)} USDT → USDC.e`}
                    </button>
                  )}
                </div>
              )}

              {/* Autonomous mode toggle */}
              <div
                style={{
                  background: "var(--surface)",
                  borderRadius: 8,
                  padding: "14px 16px",
                  marginBottom: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Auto-convert future deposits
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    Every 5 min the orchestrator checks your wallet. If you have
                    &gt; 1 USDT, it auto-swaps to USDC.e.
                  </div>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={user.autonomousMode}
                    onChange={(e) =>
                      onSetAutonomousMode(e.target.checked).catch(() => {})
                    }
                  />
                  {user.autonomousMode ? "On" : "Off"}
                </label>
              </div>

              {error && (
                <p style={{ color: "#ff3b30", marginBottom: 12, fontSize: 13 }}>
                  {error}
                </p>
              )}

              {!user.botsRunning ? (
                <button
                  className="btn-primary"
                  onClick={handleStartBots}
                  disabled={starting}
                >
                  {starting ? "Starting…" : "Start My Bots"}
                </button>
              ) : (
                <p style={{ color: "#4caf50", fontWeight: 600 }}>
                  ✓ Bots are running
                </p>
              )}
            </div>
          ) : (
            <div>
              <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
                Please go back to Step 2 and save your Polymarket proxy wallet
                address to continue.
              </p>
              <button className="btn-secondary" onClick={() => setStep(2)}>
                Back to Step 2
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
