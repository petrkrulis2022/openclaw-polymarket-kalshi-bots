import React, { useEffect, useMemo, useState } from "react";

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
      };
      if (!res.ok) {
        setManualStatusByKey((prev) => ({
          ...prev,
          [key]: payload.message ?? payload.error ?? payload.reason ?? "Manual trigger failed",
        }));
        return;
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

  return (
    <div>
      <div className="hky-toolbar">
        <div className="hky-toolbar-left">
          <span className="hky-dot" />
          <span>Live Poll {pollTick}</span>
        </div>
        <div className="hky-toolbar-right">1s refresh</div>
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

      <div className="hky-cards-grid">
        {cards.map((m) => {
          const live = isLiveStatus(m.status);
          const canManualTrigger = selectedWatchedGameKey === m.key;
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
