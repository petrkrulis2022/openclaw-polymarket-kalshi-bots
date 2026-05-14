/**
 * AdminPanel.tsx
 *
 * Password-protected admin overlay. Shows all registered users with live
 * on-chain balances. Password is stored in sessionStorage so it survives
 * page refreshes without re-prompting.
 */

import React, { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminUser {
  metamask_address: string;
  bot_wallet_address: string | null;
  bot_wallet_index: number;
  has_api_keys: boolean;
  bots_running: boolean;
  autonomous_mode: boolean;
  created_at: number;
  bot_allocations?: Record<string, boolean>;
  bot_diagnostics?: Record<
    string,
    { healthy?: boolean; lastTradeReconcileAt?: string; lastScanAt?: string; lastQuoteAt?: string }
  >;
  usdt: string | null;
  usdce: string | null;
  native_pol: string | null;
  deposit_wallet_address: string | null;
  deposit_wallet_pusd: string | null;
  deposit_wallet_usdce: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_KEY = "admin_token";

function abbrevAddr(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function polToEther(wei: string | null): string {
  if (wei === null) return "—";
  const n = Number(wei) / 1e18;
  return n.toFixed(4);
}

function fmtToken(val: string | null): string {
  if (val === null) return "—";
  return parseFloat(val).toFixed(2);
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function botAllocSummary(allocations?: Record<string, boolean>): string {
  const botNames = [
    "market-maker",
    "copy-trader",
    "in-market-arb",
    "resolution-lag",
    "microstructure",
  ];
  return botNames
    .map((name) => `${name}:${allocations?.[name] === false ? "off" : "on"}`)
    .join(" · ");
}

function botDiagSummary(
  diagnostics?: Record<
    string,
    { healthy?: boolean; lastTradeReconcileAt?: string; lastScanAt?: string; lastQuoteAt?: string }
  >,
): string {
  const botNames = [
    "market-maker",
    "copy-trader",
    "in-market-arb",
    "resolution-lag",
    "microstructure",
  ];
  return botNames
    .map((name) => {
      const d = diagnostics?.[name];
      const state = d?.healthy === false ? "offline" : d ? "ok" : "unknown";
      return `${name}:${state}`;
    })
    .join(" · ");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState(
    () => sessionStorage.getItem(SESSION_KEY) ?? "",
  );
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
    const [botDiagnostics, setBotDiagnostics] = useState<
      Record<string, Record<string, AdminUser["bot_diagnostics"] extends infer T ? T : never>>
    >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fund transfer state ───────────────────────────────────────────────────
  const [xferFrom, setXferFrom] = useState("");
  const [xferTo, setXferTo] = useState("");
  const [xferAmount, setXferAmount] = useState("");
  const [xferLoading, setXferLoading] = useState(false);
  const [xferResult, setXferResult] = useState<string | null>(null);
  const [xferError, setXferError] = useState<string | null>(null);

  const fetchUsers = useCallback(async (pw: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/orchestrator/admin/users", {
        headers: { Authorization: `Bearer ${pw}` },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(SESSION_KEY);
        setAuthed(false);
        setError("Wrong password.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as AdminUser[];
      sessionStorage.setItem(SESSION_KEY, pw);
      setUsers(data);
      setAuthed(true);
      void Promise.all(
        data.map(async (user) => {
          const botNames = [
            "market-maker",
            "copy-trader",
            "in-market-arb",
            "resolution-lag",
            "microstructure",
          ];
          const entries = await Promise.all(
            botNames.map(async (botName) => {
              try {
                const diagRes = await fetch(
                  `/api/orchestrator/users/${user.metamask_address}/bots/${botName}/diagnostics`,
                  { headers: { Authorization: `Bearer ${pw}` } },
                );
                if (!diagRes.ok) return [botName, null] as const;
                return [botName, await diagRes.json()] as const;
              } catch {
                return [botName, null] as const;
              }
            }),
          );
          setBotDiagnostics((prev) => ({
            ...prev,
            [user.metamask_address]: Object.fromEntries(entries),
          }));
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-login if we already have a stored token
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) fetchUsers(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchUsers(password);
  };

  // ── Totals ────────────────────────────────────────────────────────────────

  const totalUsdt = users.reduce(
    (s, u) => s + (u.usdt ? parseFloat(u.usdt) : 0),
    0,
  );
  const totalUsdce = users.reduce(
    (s, u) =>
      s + (u.deposit_wallet_usdce ? parseFloat(u.deposit_wallet_usdce) : 0),
    0,
  );
  const totalPusd = users.reduce(
    (s, u) =>
      s + (u.deposit_wallet_pusd ? parseFloat(u.deposit_wallet_pusd) : 0),
    0,
  );

  const forceBotsRunning = async (address: string, running: boolean) => {
    const pw = sessionStorage.getItem(SESSION_KEY) ?? password;
    await fetch(`/api/orchestrator/admin/users/${address}/set-bots-running`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pw}`,
      },
      body: JSON.stringify({ running }),
    });
    void fetchUsers(pw);
  };

  const transferFunds = async () => {
    if (!xferFrom || !xferTo) {
      setXferError("Select both source and destination.");
      return;
    }
    const pw = sessionStorage.getItem(SESSION_KEY) ?? password;
    setXferLoading(true);
    setXferResult(null);
    setXferError(null);
    try {
      const body: Record<string, string> = {
        fromMetamask: xferFrom,
        toMetamask: xferTo,
      };
      if (xferAmount.trim()) body["amountUsdce"] = xferAmount.trim();
      const res = await fetch("/api/orchestrator/admin/transfer-funds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pw}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, string>;
      if (!res.ok) {
        setXferError((data["error"] as string) ?? `Error ${res.status}`);
      } else {
        setXferResult(
          `✓ Transferred ${data["amount"]} USDC.e · tx ${String(data["txHash"]).slice(0, 18)}…`,
        );
        setXferAmount("");
        void fetchUsers(pw);
      }
    } catch (e) {
      setXferError(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setXferLoading(false);
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.82)",
    zIndex: 9999,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  const header: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderBottom: "1px solid var(--border)",
    background: "var(--surface)",
    flexShrink: 0,
  };

  const tableWrapper: React.CSSProperties = {
    flex: 1,
    overflow: "auto",
    padding: "16px 24px 24px",
  };

  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "8px 12px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    background: "var(--surface)",
  };

  const td: React.CSSProperties = {
    padding: "8px 12px",
    fontSize: 13,
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  };

  // ── Render: password gate ─────────────────────────────────────────────────

  if (!authed) {
    return (
      <div style={overlay}>
        <div style={header}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>
            ⚙ Admin Dashboard
          </span>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            className="card"
            style={{ width: 340, padding: 28, textAlign: "center" }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 18 }}>
              Admin Login
            </div>
            <form
              onSubmit={handleLogin}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <input
                type="password"
                placeholder="Admin password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                style={{
                  padding: "10px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  color: "var(--text)",
                  fontSize: 14,
                }}
              />
              {error && (
                <p style={{ color: "#ff3b30", fontSize: 12, margin: 0 }}>
                  {error}
                </p>
              )}
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? "Verifying…" : "Enter"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: user table ────────────────────────────────────────────────────

  const botsRunningCount = users.filter((u) => u.bots_running).length;
  const storedPw = sessionStorage.getItem(SESSION_KEY) ?? password;

  return (
    <div style={overlay}>
      <div style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>
            ⚙ Admin Dashboard
          </span>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {users.length} users · {botsRunningCount} bots running · pUSD:{" "}
            <span style={{ color: "#4caf50", fontWeight: 700 }}>
              {totalPusd.toFixed(2)}
            </span>{" "}
            · USDT: {totalUsdt.toFixed(2)} · USDC.e: {totalUsdce.toFixed(2)}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="btn-secondary"
            onClick={() => void fetchUsers(storedPw)}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Close ✕
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 24px",
            background: "#3b1a1a",
            color: "#ff6b6b",
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      <div style={tableWrapper}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            background: "var(--surface)",
            borderRadius: 8,
          }}
        >
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>MetaMask address</th>
              <th style={th}>Bot wallet / Deposit wallet</th>
              <th style={th}>Idx</th>
              <th style={th}>Bots running</th>
              <th style={th}>Allocation</th>
              <th style={th}>Health</th>
              <th style={th}>Auto</th>
              <th style={{ ...th, color: "#4caf50", fontWeight: 800 }}>pUSD</th>
              <th style={{ ...th, color: "#4caf50" }}>USDT</th>
              <th style={{ ...th, color: "#2196f3" }}>USDC.e</th>
              <th style={{ ...th, color: "#ff9800" }}>POL</th>
              <th style={th}>Actions</th>
              <th style={th}>Registered</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr
                key={u.metamask_address}
                style={{
                  background:
                    i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                }}
              >
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {i + 1}
                </td>
                <td style={td}>
                  <span
                    title={u.metamask_address}
                    style={{ cursor: "pointer", fontFamily: "monospace" }}
                    onClick={() =>
                      void navigator.clipboard.writeText(u.metamask_address)
                    }
                  >
                    {abbrevAddr(u.metamask_address)}
                  </span>
                </td>
                <td style={td}>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 2 }}
                  >
                    <span
                      title={u.bot_wallet_address ?? ""}
                      style={{
                        cursor: "pointer",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                      onClick={() =>
                        u.bot_wallet_address &&
                        void navigator.clipboard.writeText(u.bot_wallet_address)
                      }
                    >
                      EOA: {abbrevAddr(u.bot_wallet_address)}
                    </span>
                    {u.deposit_wallet_address && (
                      <span
                        title={u.deposit_wallet_address}
                        style={{
                          cursor: "pointer",
                          fontFamily: "monospace",
                          fontSize: 11,
                          color: "#4caf50",
                        }}
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            u.deposit_wallet_address!,
                          )
                        }
                      >
                        DEP: {abbrevAddr(u.deposit_wallet_address)}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {u.bot_wallet_index}
                </td>
                <td style={td}>
                  {u.bots_running ? (
                    <span
                      style={{
                        color: "#4caf50",
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                    >
                      ● RUNNING
                    </span>
                  ) : (
                    <span style={{ color: "#666", fontSize: 12 }}>
                      ● stopped
                    </span>
                  )}
                </td>
                <td style={{ ...td, fontSize: 12, color: "var(--text-secondary)" }}>
                  {botAllocSummary(u.bot_allocations)}
                </td>
                <td style={{ ...td, fontSize: 12, color: "var(--text-secondary)" }}>
                  {botDiagSummary(botDiagnostics[u.metamask_address])}
                </td>
                <td style={td}>
                  {u.autonomous_mode ? (
                    <span style={{ color: "#2196f3" }}>✓</span>
                  ) : (
                    <span style={{ color: "#666" }}>—</span>
                  )}
                </td>
                <td
                  style={{
                    ...td,
                    color: "#4caf50",
                    fontWeight: 800,
                    fontSize: 14,
                  }}
                >
                  {fmtToken(u.deposit_wallet_pusd)}
                </td>
                <td style={{ ...td, color: "#4caf50", fontWeight: 600 }}>
                  {fmtToken(u.usdt)}
                </td>
                <td style={{ ...td, color: "#2196f3", fontWeight: 600 }}>
                  {fmtToken(u.deposit_wallet_usdce)}
                </td>
                <td style={{ ...td, color: "#ff9800" }}>
                  {polToEther(u.native_pol)}
                </td>
                <td style={td}>
                  {u.bots_running ? (
                    <button
                      className="btn-secondary"
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        color: "#ff3b30",
                      }}
                      onClick={() =>
                        void forceBotsRunning(u.metamask_address, false)
                      }
                    >
                      ■ Stop
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() =>
                        void forceBotsRunning(u.metamask_address, true)
                      }
                    >
                      ▶ Set Running
                    </button>
                  )}
                </td>
                <td
                  style={{
                    ...td,
                    color: "var(--text-secondary)",
                    fontSize: 12,
                  }}
                >
                  {fmtDate(u.created_at)}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td
                  colSpan={14}
                  style={{
                    ...td,
                    textAlign: "center",
                    color: "var(--text-secondary)",
                    padding: 32,
                  }}
                >
                  No users registered yet.
                </td>
              </tr>
            )}
          </tbody>
          {users.length > 0 && (
            <tfoot>
              <tr>
                <td
                  colSpan={5}
                  style={{
                    ...td,
                    fontWeight: 700,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  TOTAL
                </td>
                <td style={td} />
                <td
                  style={{
                    ...td,
                    color: "#4caf50",
                    fontWeight: 800,
                    fontSize: 14,
                  }}
                >
                  {totalPusd.toFixed(2)}
                </td>
                <td style={{ ...td, color: "#4caf50", fontWeight: 700 }}>
                  {totalUsdt.toFixed(2)}
                </td>
                <td style={{ ...td, color: "#2196f3", fontWeight: 700 }}>
                  {totalUsdce.toFixed(2)}
                </td>
                <td colSpan={3} style={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── Fund Transfer Panel ─────────────────────────────────────────── */}
      <div
        style={{
          padding: "16px 24px 24px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 13,
            marginBottom: 12,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Transfer USDC.e between bot wallets
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <select
            value={xferFrom}
            onChange={(e) => setXferFrom(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--text)",
              fontSize: 13,
              minWidth: 200,
            }}
          >
            <option value="">From user…</option>
            {users
              .filter((u) => u.bot_wallet_address)
              .map((u) => (
                <option key={u.metamask_address} value={u.metamask_address}>
                  {abbrevAddr(u.metamask_address)} · USDC.e {fmtToken(u.usdce)}
                </option>
              ))}
          </select>

          <span style={{ color: "var(--text-secondary)", fontSize: 16 }}>
            →
          </span>

          <select
            value={xferTo}
            onChange={(e) => setXferTo(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--text)",
              fontSize: 13,
              minWidth: 200,
            }}
          >
            <option value="">To user…</option>
            {users
              .filter(
                (u) => u.bot_wallet_address && u.metamask_address !== xferFrom,
              )
              .map((u) => (
                <option key={u.metamask_address} value={u.metamask_address}>
                  {abbrevAddr(u.metamask_address)} · pUSD{" "}
                  {fmtToken(u.deposit_wallet_pusd)}
                </option>
              ))}
          </select>

          <input
            type="text"
            placeholder="Amount USDC.e (blank = all)"
            value={xferAmount}
            onChange={(e) => setXferAmount(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--text)",
              fontSize: 13,
              width: 200,
            }}
          />

          <button
            className="btn-primary"
            style={{ padding: "8px 18px", fontSize: 13 }}
            disabled={xferLoading || !xferFrom || !xferTo}
            onClick={() => void transferFunds()}
          >
            {xferLoading ? "Transferring…" : "Transfer"}
          </button>
        </div>

        {xferResult && (
          <p style={{ color: "#4caf50", fontSize: 13, marginTop: 8 }}>
            {xferResult}
          </p>
        )}
        {xferError && (
          <p style={{ color: "#ff3b30", fontSize: 13, marginTop: 8 }}>
            {xferError}
          </p>
        )}
        <p
          style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 6 }}
        >
          Moves USDC.e from the source bot EOA to the destination bot EOA.
          Source must have USDC.e (withdraw pUSD first if needed). After
          transfer, click Deposit to Polymarket in the destination user's
          dashboard.
        </p>
      </div>
    </div>
  );
}
