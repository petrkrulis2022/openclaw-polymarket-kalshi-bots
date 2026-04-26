/**
 * UserOnboarding.tsx
 *
 * 3-step onboarding flow shown when a new user connects their wallet:
 *
 *  Step 1 — Fund bot wallet: display the server-generated EOA address and
 *            instruct the user to send USDC.e on Polygon.
 *  Step 2 — Generate Polymarket API keys for their bot wallet address.
 *  Step 3 — Enter API key, secret, and passphrase into the form.
 */

import React, { useState } from "react";
import type { UserRecord } from "../hooks/use-user";

interface Props {
  user: UserRecord;
  onSaveApiKeys: (
    apiKey: string,
    apiSecret: string,
    apiPassphrase: string,
  ) => Promise<void>;
  onStartBots: () => Promise<void>;
}

function abbrev(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

export function UserOnboarding({ user, onSaveApiKeys, onStartBots }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const botAddr = user.botWalletAddress ?? "";

  const handleSaveKeys = async () => {
    if (!apiKey.trim() || !apiSecret.trim() || !apiPassphrase.trim()) {
      setError("All three fields are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveApiKeys(
        apiKey.trim(),
        apiSecret.trim(),
        apiPassphrase.trim(),
      );
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
            {s === 1 ? "Fund" : s === 2 ? "API Keys" : "Activate"}
          </span>
        ))}
      </div>

      {/* Step 1 — Fund bot wallet */}
      {step === 1 && (
        <div>
          <p style={{ marginBottom: 12, lineHeight: 1.6 }}>
            OpenClaw generated a dedicated trading wallet for you. Send{" "}
            <strong>USDC.e on Polygon</strong> to this address to fund your
            bots:
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

          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginBottom: 16,
            }}
          >
            Token: USDC.e (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)
            &nbsp;·&nbsp; Network: Polygon
          </p>

          <button className="btn-primary" onClick={() => setStep(2)}>
            I've funded it → Next
          </button>
        </div>
      )}

      {/* Step 2 — Generate Polymarket API keys */}
      {step === 2 && (
        <div>
          <p style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Generate API keys on Polymarket for your bot wallet address{" "}
            <strong>{abbrev(botAddr)}</strong>. OpenClaw needs these to place
            orders on your behalf.
          </p>

          <ol style={{ paddingLeft: 20, lineHeight: 2, marginBottom: 16 }}>
            <li>
              Open{" "}
              <a
                href="https://polymarket.com/settings"
                target="_blank"
                rel="noopener noreferrer"
              >
                polymarket.com/settings
              </a>{" "}
              and connect MetaMask.
            </li>
            <li>Switch MetaMask to your bot address (import it first).</li>
            <li>
              Go to <em>API Keys</em> → <strong>Create Key</strong>.
            </li>
            <li>Copy the API Key, Secret, and Passphrase.</li>
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
            <strong>Bot wallet address:</strong>
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

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn-primary" onClick={() => setStep(3)}>
              I have my API keys → Next
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Enter API keys */}
      {step === 3 && (
        <div>
          {user.hasApiKeys ? (
            <div>
              <p style={{ marginBottom: 16, color: "#4caf50" }}>
                ✓ API keys are saved. Your bots are ready to run.
              </p>
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
                Enter the Polymarket API credentials you generated for{" "}
                <strong>{abbrev(botAddr)}</strong>:
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    API Key (UUID)
                  </label>
                  <input
                    type="text"
                    className="input"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    API Secret (base64)
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="base64-encoded secret"
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    API Passphrase (hex)
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="hex passphrase"
                    value={apiPassphrase}
                    onChange={(e) => setApiPassphrase(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              {error && (
                <p style={{ color: "#ff3b30", marginBottom: 12, fontSize: 13 }}>
                  {error}
                </p>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn-secondary" onClick={() => setStep(2)}>
                  Back
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSaveKeys}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save API Keys"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
