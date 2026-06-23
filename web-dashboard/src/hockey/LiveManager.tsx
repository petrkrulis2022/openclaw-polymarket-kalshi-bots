import React, { useEffect, useMemo, useState } from "react";
import { useSportsBot, TriggerTiming } from "../hooks/use-sports-bot";

export type HockeyFeedMatch = {
  key: string;
  staticId: string;
  fixId: string;
  leagueName: string;
  country: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  timer: string;
  scoreHome: number;
  scoreAway: number;
  periodScores: Array<{ period: string; score: string }>;
  events: string[];
  date: string;
  time: string;
  bucket: "today" | "tomorrow";
};

type Props = {
  botName: "hockey-bot" | "football-bot" | "tennis-bot";
  selectedKeys: string[];
  baseByKey: Record<string, HockeyFeedMatch>;
  metamaskAddress?: string;
  onRemove: (key: string) => void;
};

const BOT_NAME_TO_ID: Record<string, number> = {
  "football-bot": 8,
  "hockey-bot": 10,
  "tennis-bot": 11,
};

function isLiveStatus(status: string): boolean {
  const s = status.toLowerCase();
  if (!s) return false;
  if (
    s.includes("not started") ||
    s.includes("finished") ||
    s.includes("final")
  )
    return false;
  if (s.includes("period") || s.includes("in progress") || s.includes("live"))
    return true;
  return /^\d/.test(s);
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmtLatency(fromMs?: number, toMs?: number): string {
  if (fromMs == null || toMs == null) return "—";
  const diff = toMs - fromMs;
  return diff < 0 ? "—" : `+${diff}ms`;
}

function fmtElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}′ ${String(s).padStart(2, "0")}″`;
}

function TimingPanel({ timing }: { timing: TriggerTiming }) {
  const { clientTriggeredAtMs, serverReceivedAtMs, botDetectedAtMs, botFilledAtMs } = timing;
  const totalMs =
    clientTriggeredAtMs != null && botFilledAtMs != null
      ? botFilledAtMs - clientTriggeredAtMs
      : null;

  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        background: "#0d1f2d",
        border: "1px solid #1e3a5f",
        borderRadius: 6,
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, color: "#90caf9", marginBottom: 4 }}>
        Trigger Timing{totalMs != null ? ` — total ${totalMs}ms` : ""}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 4,
        }}
      >
        {[
          { label: "User click", ms: clientTriggeredAtMs, delta: null },
          {
            label: "Server recv",
            ms: serverReceivedAtMs,
            delta: fmtLatency(clientTriggeredAtMs, serverReceivedAtMs),
          },
          {
            label: "Bot detect",
            ms: botDetectedAtMs,
            delta: fmtLatency(serverReceivedAtMs, botDetectedAtMs),
          },
          {
            label: "Order fill",
            ms: botFilledAtMs,
            delta: fmtLatency(botDetectedAtMs, botFilledAtMs),
          },
        ].map(({ label, ms, delta }) => (
          <div
            key={label}
            style={{
              background: "#0a1520",
              borderRadius: 4,
              padding: "4px 6px",
              textAlign: "center",
            }}
          >
            <div style={{ color: "#546e7a", marginBottom: 2 }}>{label}</div>
            <div style={{ color: "#b0bec5", fontFamily: "monospace" }}>
              {ms != null ? fmtTime(ms) : "—"}
            </div>
            {delta != null && (
              <div style={{ color: "#4db6ac", fontSize: 10 }}>{delta}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LiveManager({
  botName,
  selectedKeys,
  baseByKey,
  metamaskAddress,
  onRemove,
}: Props) {
  const [liveByKey, setLiveByKey] = useState<Record<string, HockeyFeedMatch>>(
    {},
  );
  const [pollTick, setPollTick] = useState(0);
  const [selectedWatchedGameKey, setSelectedWatchedGameKey] = useState<
    string | null
  >(null);
  const [manualPendingKey, setManualPendingKey] = useState<string | null>(null);
  const [manualStatusByKey, setManualStatusByKey] = useState<
    Record<string, string>
  >({});
  const [botReady, setBotReady] = useState<{
    ready: boolean;
    marketReady: boolean;
    signingClientReady: boolean;
    lastSetupError: string | null;
  } | null>(null);
  const [lastTimingByKey, setLastTimingByKey] = useState<
    Record<string, TriggerTiming>
  >({});
  const [gameElapsedMs, setGameElapsedMs] = useState<number | null>(null);
  const [sellPending, setSellPending] = useState(false);
  const [sellStatus, setSellStatus] = useState<string | null>(null);

  const botId = BOT_NAME_TO_ID[botName] ?? 10;
  const { data: botData } = useSportsBot(botId, metamaskAddress);

  // Game clock — update every second while gameStartDate is available
  useEffect(() => {
    if (!botData.gameStartDate) {
      setGameElapsedMs(null);
      return;
    }
    const startMs = Date.parse(botData.gameStartDate);
    if (isNaN(startMs)) {
      setGameElapsedMs(null);
      return;
    }
    const update = () => setGameElapsedMs(Date.now() - startMs);
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [botData.gameStartDate]);

  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      if (!metamaskAddress) return;
      try {
        const res = await fetch(
          `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/watchlist-state`,
        );
        if (!res.ok) return;
        const payload = (await res.json()) as {
          games?: Array<Partial<HockeyFeedMatch> & { key: string }>;
          selectedWatchedGameKey?: string | null;
          marketReady?: boolean;
          signingClientReady?: boolean;
          ready?: boolean;
          lastSetupError?: string | null;
        };
        if (stopped) return;

        setBotReady({
          ready: Boolean(payload.ready),
          marketReady: Boolean(payload.marketReady),
          signingClientReady: Boolean(payload.signingClientReady),
          lastSetupError: payload.lastSetupError ?? null,
        });

        const next: Record<string, HockeyFeedMatch> = {};
        for (const match of payload.games ?? []) {
          const base = baseByKey[match.key] as HockeyFeedMatch | undefined;
          const liveStatus = String(
            match.status ?? base?.status ?? "Not Started",
          );
          const baseStatus = String(base?.status ?? "");
          const preferBaseScore =
            !isLiveStatus(liveStatus) && isLiveStatus(baseStatus);
          next[match.key] = {
            key: match.key,
            staticId: String(match.staticId ?? base?.staticId ?? ""),
            fixId: String(match.fixId ?? base?.fixId ?? ""),
            leagueName: String(
              match.leagueName ?? base?.leagueName ?? "Hockey",
            ),
            country: String(match.country ?? base?.country ?? ""),
            homeTeam: String(match.homeTeam ?? base?.homeTeam ?? "Home"),
            awayTeam: String(match.awayTeam ?? base?.awayTeam ?? "Away"),
            status: preferBaseScore
              ? String(base?.status ?? liveStatus)
              : liveStatus,
            timer: preferBaseScore
              ? String(base?.timer ?? match.timer ?? "")
              : String(match.timer ?? base?.timer ?? ""),
            scoreHome: preferBaseScore
              ? Number(base?.scoreHome ?? match.scoreHome ?? 0)
              : Number(match.scoreHome ?? base?.scoreHome ?? 0),
            scoreAway: preferBaseScore
              ? Number(base?.scoreAway ?? match.scoreAway ?? 0)
              : Number(match.scoreAway ?? base?.scoreAway ?? 0),
            periodScores: Array.isArray(match.periodScores)
              ? match.periodScores
              : (base?.periodScores ?? []),
            events: Array.isArray(match.events)
              ? match.events
              : (base?.events ?? []),
            date: String(match.date ?? base?.date ?? ""),
            time: String(match.time ?? base?.time ?? ""),
            bucket:
              (match.bucket as "today" | "tomorrow") ?? base?.bucket ?? "today",
          };
        }
        setLiveByKey(next);
        setSelectedWatchedGameKey(payload.selectedWatchedGameKey ?? null);
        setPollTick((t) => t + 1);
      } catch {
        // keep last known snapshot
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 1_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [metamaskAddress, baseByKey, botName]);

  const triggerManual = async (
    key: string,
    side: "home" | "away",
  ): Promise<void> => {
    if (!metamaskAddress || manualPendingKey) return;
    setManualPendingKey(key);
    setManualStatusByKey((prev) => ({
      ...prev,
      [key]: side === "home" ? "Triggering Team A..." : "Triggering Team B...",
    }));

    try {
      const clientTriggeredAtMs = Date.now();
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/manual-trigger`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, side, clientTriggeredAtMs }),
        },
      );
      const payload = (await res.json()) as {
        message?: string;
        reason?: string;
        error?: string;
        timing?: TriggerTiming;
      };
      if (!res.ok) {
        setManualStatusByKey((prev) => ({
          ...prev,
          [key]: payload.message ?? payload.error ?? payload.reason ?? "Manual trigger failed",
        }));
        return;
      }

      if (payload.timing) {
        setLastTimingByKey((prev) => ({ ...prev, [key]: payload.timing! }));
      }
      setManualStatusByKey((prev) => ({
        ...prev,
        [key]: payload.message ?? "Executed",
      }));
    } catch {
      setManualStatusByKey((prev) => ({
        ...prev,
        [key]: "Manual trigger failed: orchestrator unavailable",
      }));
    } finally {
      setManualPendingKey(null);
    }
  };

  // Manual sell — the user decides when to exit. Goes through the generic bot
  // proxy to POST /force-sell (immediate market sell, recorded as "manual").
  const triggerSell = async (): Promise<void> => {
    if (!metamaskAddress || sellPending) return;
    setSellPending(true);
    setSellStatus("Selling…");
    try {
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${botName}/proxy/force-sell`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const payload = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      setSellStatus(
        res.ok
          ? (payload.message ?? "Sell submitted")
          : (payload.error ?? "Sell failed"),
      );
    } catch {
      setSellStatus("Sell failed: orchestrator unavailable");
    } finally {
      setSellPending(false);
    }
  };

  const cards = useMemo(() => {
    return selectedKeys
      .map((key) => liveByKey[key] ?? baseByKey[key])
      .filter((m): m is HockeyFeedMatch => Boolean(m));
  }, [selectedKeys, liveByKey, baseByKey]);

  if (cards.length === 0) {
    return (
      <div className="hky-empty">
        Select games from the left panel to start live tracking.
      </div>
    );
  }

  const openPos = botData.openPosition;
  const lastTrade = botData.trades[botData.trades.length - 1] ?? null;

  return (
    <div>
      <div className="hky-toolbar">
        <div className="hky-toolbar-left">
          <span className="hky-dot" />
          <span>Live Poll {pollTick}</span>
        </div>
        <div className="hky-toolbar-right">
          {gameElapsedMs != null ? (
            <span style={{ color: "#4db6ac", fontWeight: 600 }}>
              ⏱ {fmtElapsed(gameElapsedMs)}
            </span>
          ) : (
            "1s refresh"
          )}
        </div>
      </div>

      {/* Bot readiness indicator */}
      {botReady !== null && (
        <div
          style={{
            margin: "0 0 10px 0",
            padding: "8px 12px",
            borderRadius: 8,
            background: botReady.ready ? "#1b3a1b" : "#3a2000",
            border: `1px solid ${botReady.ready ? "#4caf50" : "#ff9800"}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ fontSize: 16 }}>{botReady.ready ? "✅" : "⏳"}</span>
          <span
            style={{
              fontWeight: 600,
              color: botReady.ready ? "#4caf50" : "#ff9800",
            }}
          >
            {botReady.ready
              ? botName === "tennis-bot"
                ? "Bot ready — will trade on next set win"
                : "Bot ready — will trade on next goal"
              : "Bot initializing…"}
          </span>
          <span style={{ color: "var(--text-secondary)", marginLeft: 4 }}>
            Market: {botReady.marketReady ? "✓" : "✗"}
            {" · "}
            Signing: {botReady.signingClientReady ? "✓" : "✗"}
          </span>
          {!botReady.ready && botReady.lastSetupError && (
            <span style={{ color: "#ff6b6b", marginLeft: 4 }}>
              — {botReady.lastSetupError}
            </span>
          )}
        </div>
      )}

      {/* Live both-team prices — visible before, during, and after the trigger */}
      {botData.prices &&
        (botData.prices.yesAsk > 0 || botData.prices.noAsk > 0) && (
          <div
            style={{
              marginBottom: 10,
              padding: "8px 12px",
              background: "#11202b",
              border: "1px solid #1f4f6b",
              borderRadius: 8,
              fontSize: 12,
              display: "flex",
              gap: 24,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#90caf9", fontWeight: 600 }}>
              💹 Live prices
            </span>
            <span style={{ color: "#e0e0e0" }}>
              Team A (YES): bid{" "}
              <b>{(botData.prices.yesBid * 100).toFixed(1)}¢</b> / ask{" "}
              <b>{(botData.prices.yesAsk * 100).toFixed(1)}¢</b>
            </span>
            <span style={{ color: "#e0e0e0" }}>
              Team B (NO): bid <b>{(botData.prices.noBid * 100).toFixed(1)}¢</b>{" "}
              / ask <b>{(botData.prices.noAsk * 100).toFixed(1)}¢</b>
            </span>
          </div>
        )}

      {/* Open position summary + manual sell */}
      {openPos && (
        <div
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            background: "#1a2a1a",
            border: "1px solid #2e7d32",
            borderRadius: 8,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span style={{ color: "#e0e0e0" }}>
            <span style={{ color: "#81c784", fontWeight: 600 }}>📈 Open: </span>
            {openPos.size.toFixed(2)} {openPos.label} @ entry{" "}
            {(openPos.entryAsk * 100).toFixed(1)}¢
            {openPos.currentBid != null && openPos.currentBid > 0 && (
              <>
                {" "}
                | now bid {(openPos.currentBid * 100).toFixed(1)}¢ | P&amp;L{" "}
                <span
                  style={{
                    color:
                      (openPos.unrealizedPnl ?? 0) >= 0 ? "#81c784" : "#ef9a9a",
                    fontWeight: 600,
                  }}
                >
                  {(openPos.unrealizedPnl ?? 0) >= 0 ? "+" : ""}
                  {(openPos.unrealizedPnl ?? 0).toFixed(2)} USDC
                </span>
              </>
            )}
          </span>
          <button
            onClick={() => void triggerSell()}
            disabled={sellPending}
            style={{
              marginLeft: "auto",
              padding: "4px 12px",
              background: sellPending ? "#444" : "#c62828",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: sellPending ? "default" : "pointer",
              fontWeight: 600,
            }}
          >
            {sellPending ? "Selling…" : "Sell now"}
          </button>
          {sellStatus && (
            <span style={{ color: "#90caf9", width: "100%" }}>{sellStatus}</span>
          )}
        </div>
      )}

      {/* Last closed trade */}
      {lastTrade && !openPos && (
        <div
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            background: lastTrade.pnl >= 0 ? "#1a2a1a" : "#2a1a1a",
            border: `1px solid ${lastTrade.pnl >= 0 ? "#2e7d32" : "#c62828"}`,
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          <span
            style={{
              color: lastTrade.pnl >= 0 ? "#81c784" : "#ef9a9a",
              fontWeight: 600,
            }}
          >
            {lastTrade.pnl >= 0 ? "✅" : "❌"} Closed:{" "}
          </span>
          <span style={{ color: "#e0e0e0" }}>
            Sold {lastTrade.size.toFixed(2)} shares @{" "}
            {(lastTrade.sellPrice * 100).toFixed(1)}¢ | P&amp;L:{" "}
            <span
              style={{ color: lastTrade.pnl >= 0 ? "#81c784" : "#ef9a9a" }}
            >
              {lastTrade.pnl >= 0 ? "+" : ""}
              {lastTrade.pnl.toFixed(2)} USDC
            </span>{" "}
            | {lastTrade.reason}
          </span>
        </div>
      )}

      <div className="hky-cards-grid">
        {cards.map((m) => {
          const live = isLiveStatus(m.status);
          const canManualTrigger = selectedWatchedGameKey === m.key;
          const triggerTiming =
            lastTimingByKey[m.key] ??
            (selectedWatchedGameKey === m.key ? openPos?.timing : undefined);
          return (
            <div key={m.key} className="hky-card">
              <div className="hky-card-top">
                <span className="hky-chip">{m.leagueName}</span>
                <span className={`hky-chip ${live ? "hky-chip-live" : ""}`}>
                  {m.timer ? `${m.status} ${m.timer}` : m.status}
                </span>
                <button className="hky-close" onClick={() => onRemove(m.key)}>
                  x
                </button>
              </div>

              <div className="hky-scoreline">
                <div>{m.homeTeam}</div>
                <div className="hky-score">
                  {m.scoreHome} - {m.scoreAway}
                </div>
                <div>{m.awayTeam}</div>
              </div>

              {canManualTrigger ? (
                <div className="hky-manual-row">
                  <button
                    className="hky-manual-btn"
                    onClick={() => {
                      void triggerManual(m.key, "home");
                    }}
                    disabled={manualPendingKey === m.key}
                  >
                    {botName === "tennis-bot" ? "Player A Won Set" : "Team A Scored"}
                  </button>
                  <button
                    className="hky-manual-btn hky-manual-btn-right"
                    onClick={() => {
                      void triggerManual(m.key, "away");
                    }}
                    disabled={manualPendingKey === m.key}
                  >
                    {botName === "tennis-bot" ? "Player B Won Set" : "Team B Scored"}
                  </button>
                </div>
              ) : null}

              {manualStatusByKey[m.key] ? (
                <div className="hky-manual-status">
                  {manualStatusByKey[m.key]}
                </div>
              ) : null}

              {triggerTiming ? (
                <TimingPanel timing={triggerTiming} />
              ) : null}

              {m.periodScores.length > 0 && (
                <div className="hky-periods">
                  {m.periodScores.map((p) => (
                    <div key={`${m.key}-${p.period}`}>
                      <div className="hky-period-label">{p.period}</div>
                      <div>{p.score}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="hky-events">
                {m.events.length === 0 ? (
                  <div className="hky-muted">No events yet</div>
                ) : (
                  m.events.slice(0, 10).map((e, idx) => (
                    <div key={`${m.key}-ev-${idx}`} className="hky-event-line">
                      {e}
                    </div>
                  ))
                )}
              </div>

              <div className="hky-footer-row">
                <span className="hky-muted">
                  #{m.staticId || m.fixId || m.key}
                </span>
                <span className="hky-muted">
                  {m.date} {m.time} UTC
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
