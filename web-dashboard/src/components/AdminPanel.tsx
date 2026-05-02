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
  usdt: string | null;
  usdce: string | null;
  native_pol: string | null;
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

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState(
    () => sessionStorage.getItem(SESSION_KEY) ?? "",
  );
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    (s, u) => s + (u.usdce ? parseFloat(u.usdce) : 0),
    0,
  );

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
            {users.length} users · {botsRunningCount} bots running · USDT:{" "}
            {totalUsdt.toFixed(2)} · USDC.e: {totalUsdce.toFixed(2)}
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
              <th style={th}>Bot wallet</th>
              <th style={th}>Idx</th>
              <th style={th}>API keys</th>
              <th style={th}>Bots running</th>
              <th style={th}>Auto</th>
              <th style={{ ...th, color: "#4caf50" }}>USDT</th>
              <th style={{ ...th, color: "#2196f3" }}>USDC.e</th>
              <th style={{ ...th, color: "#ff9800" }}>POL</th>
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
                  <span
                    title={u.bot_wallet_address ?? ""}
                    style={{ cursor: "pointer", fontFamily: "monospace" }}
                    onClick={() =>
                      u.bot_wallet_address &&
                      void navigator.clipboard.writeText(u.bot_wallet_address)
                    }
                  >
                    {abbrevAddr(u.bot_wallet_address)}
                  </span>
                </td>
                <td style={{ ...td, color: "var(--text-secondary)" }}>
                  {u.bot_wallet_index}
                </td>
                <td style={td}>
                  {u.has_api_keys ? (
                    <span style={{ color: "#4caf50" }}>✓</span>
                  ) : (
                    <span style={{ color: "#ff3b30" }}>✗</span>
                  )}
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
                <td style={td}>
                  {u.autonomous_mode ? (
                    <span style={{ color: "#2196f3" }}>✓</span>
                  ) : (
                    <span style={{ color: "#666" }}>—</span>
                  )}
                </td>
                <td style={{ ...td, color: "#4caf50", fontWeight: 600 }}>
                  {fmtToken(u.usdt)}
                </td>
                <td style={{ ...td, color: "#2196f3", fontWeight: 600 }}>
                  {fmtToken(u.usdce)}
                </td>
                <td style={{ ...td, color: "#ff9800" }}>
                  {polToEther(u.native_pol)}
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
                  colSpan={11}
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
                  colSpan={7}
                  style={{
                    ...td,
                    fontWeight: 700,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  TOTAL
                </td>
                <td style={{ ...td, color: "#4caf50", fontWeight: 700 }}>
                  {totalUsdt.toFixed(2)}
                </td>
                <td style={{ ...td, color: "#2196f3", fontWeight: 700 }}>
                  {totalUsdce.toFixed(2)}
                </td>
                <td colSpan={2} style={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
