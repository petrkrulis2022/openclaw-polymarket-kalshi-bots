import React, { useEffect, useMemo, useState } from "react";
import { LiveManager, type HockeyFeedMatch } from "../hockey/LiveManager";
import "../hockey/styles.css";

type Props = {
  botName: string;
  metamaskAddress?: string;
  onBack: () => void;
};

const STORAGE_KEY = "openclaw:football:selected-games";
const BOT_NAME = "football-bot";
const SINGLE_KEY = "manual-football";

type WatchedGameDto = {
  key: string;
  sport: "football";
  staticId?: string;
  fixId?: string;
  leagueName?: string;
  country?: string;
  homeTeam: string;
  awayTeam: string;
  date?: string;
  time?: string;
  statusAtAdd?: string;
  matchSlug?: string;
  createdAt: number;
};

type BotReadinessDto = {
  ready?: boolean;
  stage?: string;
  unreachable?: boolean;
  missing?: string[];
  error?: string;
};

function extractMatchSlug(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  let candidate = raw;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    candidate = parts[parts.length - 1] ?? "";
  } catch {
    const cleaned = raw.split("?")[0]?.split("#")[0] ?? raw;
    const parts = cleaned.split("/").filter(Boolean);
    candidate = parts[parts.length - 1] ?? cleaned;
  }

  const slug = candidate.trim().toLowerCase();
  if (!slug) return undefined;
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  return slug;
}

export function FootballManager({ botName, metamaskAddress, onBack }: Props) {
  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? SINGLE_KEY : null;
    } catch {
      return null;
    }
  });
  const [polymarketInput, setPolymarketInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [homeTeam, setHomeTeam] = useState("Team A");
  const [awayTeam, setAwayTeam] = useState("Team B");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedKey ? polymarketInput : "");
  }, [selectedKey, polymarketInput]);

  useEffect(() => {
    let stopped = false;

    const loadPersisted = async () => {
      if (!metamaskAddress) return;
      try {
        const res = await fetch(
          `/api/orchestrator/users/${metamaskAddress}/bots/${BOT_NAME}/watched-games`,
        );
        if (!res.ok) return;
        const payload = (await res.json()) as { games?: WatchedGameDto[] };
        if (stopped) return;
        const game = payload.games?.[0];
        if (!game) {
          setSelectedKey(null);
          return;
        }
        setSelectedKey(SINGLE_KEY);
        setPolymarketInput(game.matchSlug ?? "");
        if (game.homeTeam) setHomeTeam(game.homeTeam);
        if (game.awayTeam) setAwayTeam(game.awayTeam);
      } catch {
        // local fallback remains active
      }
    };

    void loadPersisted();
    return () => {
      stopped = true;
    };
  }, [metamaskAddress]);

  const persistSelection = async (
    slugInput: string,
    clear = false,
  ): Promise<boolean> => {
    if (!metamaskAddress) return false;

    const slug = extractMatchSlug(slugInput);
    if (!clear && !slug) {
      setAssignmentStatus("Enter a valid Polymarket URL or slug");
      return false;
    }

    const games: WatchedGameDto[] = clear
      ? []
      : [
          {
            key: SINGLE_KEY,
            sport: "football",
            homeTeam,
            awayTeam,
            leagueName: "Polymarket URL",
            statusAtAdd: "Manual Trigger",
            matchSlug: slug,
            createdAt: Date.now(),
          },
        ];

    try {
      const res = await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${BOT_NAME}/watched-games`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ games }),
        },
      );
      if (!res.ok) {
        setAssignmentStatus(`Save failed (${res.status})`);
        return false;
      }

      const payload = (await res.json()) as { readiness?: BotReadinessDto };
      const readiness = payload.readiness;
      if (clear) {
        setAssignmentStatus("Game removed");
      } else if (readiness?.ready) {
        setAssignmentStatus("Bot ready and listening to this market");
      } else if (readiness?.unreachable) {
        setAssignmentStatus("Bot offline: start bot to activate game");
      } else if (readiness) {
        const missing = (readiness.missing ?? []).join(", ") || "setup";
        setAssignmentStatus(`Bot initializing: waiting for ${missing}`);
      } else {
        setAssignmentStatus("Game saved");
      }
      return true;
    } catch {
      setAssignmentStatus("Save failed: orchestrator unavailable");
      return false;
    }
  };

  const save = async (): Promise<void> => {
    setSaved(false);
    setSaving(true);
    const ok = await persistSelection(polymarketInput, false);
    setSaving(false);
    if (ok) {
      setSelectedKey(SINGLE_KEY);
      setSaved(true);
    }
  };

  const clear = async (): Promise<void> => {
    setSaving(true);
    const ok = await persistSelection("", true);
    setSaving(false);
    if (ok) {
      setSelectedKey(null);
      setSaved(false);
    }
  };

  const byKey = useMemo(() => {
    const slug = extractMatchSlug(polymarketInput) ?? "";
    if (!selectedKey || !slug) return {} as Record<string, HockeyFeedMatch>;
    const item: HockeyFeedMatch = {
      key: SINGLE_KEY,
      staticId: "",
      fixId: "",
      leagueName: "Polymarket Manual",
      country: "",
      homeTeam,
      awayTeam,
      status: "Manual Trigger",
      timer: "",
      scoreHome: 0,
      scoreAway: 0,
      periodScores: [],
      events: [`Listening to slug: ${slug}`],
      date: "",
      time: "",
      bucket: "today",
    };
    return { [SINGLE_KEY]: item };
  }, [selectedKey, polymarketInput, homeTeam, awayTeam]);

  return (
    <div className="hky-shell">
      <div className="hky-header">
        <div className="hky-brand">goal.live</div>
        <div className="hky-filter-chip">FOOTBALL</div>
        <div className="hky-header-right">
          <button className="hky-small-btn" onClick={onBack}>
            Back
          </button>
        </div>
      </div>

      <div className="hky-layout">
        <aside className="hky-sidebar">
          <div className="hky-sidebar-title">Set Polymarket Game</div>
          <div className="hky-sidebar-subtitle">
            {botName} · URL-only mode (no Goalserve feed)
          </div>

          <div className="hky-polymarket-box" style={{ marginTop: 16 }}>
            <label className="hky-polymarket-label" htmlFor="ft-poly-url">
              Polymarket URL or slug
            </label>
            <input
              id="ft-poly-url"
              className="hky-polymarket-input"
              placeholder="https://polymarket.com/sports/..."
              value={polymarketInput}
              onChange={(e) => {
                setSaved(false);
                setPolymarketInput(e.target.value);
              }}
            />

            <label
              className="hky-polymarket-label"
              htmlFor="ft-home-team"
              style={{ marginTop: 10 }}
            >
              Team A label
            </label>
            <input
              id="ft-home-team"
              className="hky-polymarket-input"
              value={homeTeam}
              onChange={(e) => setHomeTeam(e.target.value || "Team A")}
            />

            <label
              className="hky-polymarket-label"
              htmlFor="ft-away-team"
              style={{ marginTop: 10 }}
            >
              Team B label
            </label>
            <input
              id="ft-away-team"
              className="hky-polymarket-input"
              value={awayTeam}
              onChange={(e) => setAwayTeam(e.target.value || "Team B")}
            />

            <div className="hky-polymarket-actions" style={{ marginTop: 10 }}>
              <button className="hky-save-url-btn" onClick={() => void save()}>
                {saving ? "Saving..." : "Save and Activate"}
              </button>
              <button
                className="hky-save-url-btn"
                onClick={() => void clear()}
                disabled={saving}
                style={{ marginLeft: 8, background: "#2b2b2b", color: "#ddd" }}
              >
                Remove Game
              </button>
              {saved ? (
                <span className="hky-polymarket-saved">Saved</span>
              ) : null}
            </div>

            <div className="hky-polymarket-hint">
              Saved slug: {extractMatchSlug(polymarketInput) || "(none yet)"}
            </div>
          </div>

          {assignmentStatus ? (
            <div className="hky-muted">{assignmentStatus}</div>
          ) : null}
        </aside>

        <main className="hky-main">
          <LiveManager
            botName="football-bot"
            selectedKeys={selectedKey ? [selectedKey] : []}
            baseByKey={byKey}
            metamaskAddress={metamaskAddress}
            onRemove={() => {
              void clear();
            }}
          />
        </main>
      </div>
    </div>
  );
}
