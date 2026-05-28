import React, { useEffect, useMemo, useState } from "react";
import { LiveManager, type HockeyFeedMatch } from "./LiveManager";
import "./styles.css";

type Props = {
  botName: string;
  metamaskAddress?: string;
  onBack: () => void;
};

const STORAGE_KEY = "openclaw:hockey:selected-games";
const BOT_NAME = "hockey-bot";

type WatchedGameDto = {
  key: string;
  sport: "hockey";
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

function extractMatchSlug(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  // Allow full Polymarket URL, path, or direct slug value.
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

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function parseScore(value: unknown): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseKickoffTimestamp(match: HockeyFeedMatch): number {
  const date = String(match.date ?? "").trim();
  const time = String(match.time ?? "").trim();
  const dateMatch = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch) return Number.POSITIVE_INFINITY;

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  const hours = timeMatch ? Number(timeMatch[1]) : 0;
  const minutes = timeMatch ? Number(timeMatch[2]) : 0;

  // Goalserve times are UTC-like in these feeds; this keeps ordering consistent.
  return Date.UTC(year, month - 1, day, hours, minutes);
}

function rebucketByKickoffWindow(matches: HockeyFeedMatch[]): {
  today: HockeyFeedMatch[];
  tomorrow: HockeyFeedMatch[];
} {
  const now = Date.now();
  const next24h = now + 24 * 60 * 60 * 1000;
  const sorted = [...matches].sort(
    (a, b) => parseKickoffTimestamp(a) - parseKickoffTimestamp(b),
  );

  const today = sorted.filter((m) => {
    const ts = parseKickoffTimestamp(m);
    return Number.isFinite(ts) && ts <= next24h;
  });

  const tomorrow = sorted.filter((m) => {
    const ts = parseKickoffTimestamp(m);
    return Number.isFinite(ts) && ts > next24h;
  });

  if (today.length === 0 && tomorrow.length === 0) {
    return { today: sorted, tomorrow: [] };
  }

  if (today.length === 0 && tomorrow.length > 0) {
    // Fallback: keep first upcoming block visible as "Today" instead of empty UI.
    return { today: tomorrow, tomorrow: [] };
  }

  return { today, tomorrow };
}

function readField(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): unknown {
  if (!obj) return undefined;
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

function normalizeFeed(
  payload: unknown,
  bucket: "today" | "tomorrow",
): HockeyFeedMatch[] {
  const root = payload as Record<string, unknown>;
  const scores = root["scores"] as Record<string, unknown> | undefined;
  const categories = asArray(
    (scores?.["category"] as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined) ?? [],
  );

  const matches: HockeyFeedMatch[] = [];

  for (const cat of categories) {
    const country = String(readField(cat, "country", "@file_group") ?? "");
    const leagueName = String(
      (readField(cat, "name", "@name") ?? country) || "Hockey",
    );
    const matchesContainer =
      (cat["matches"] as Record<string, unknown> | undefined) ?? {};
    const rawMatches = asArray(
      ((matchesContainer["match"] ?? cat["match"]) as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined) ?? [],
    );

    for (const rawMatch of rawMatches) {
      const local =
        (rawMatch["localteam"] as Record<string, unknown> | undefined) ?? {};
      const visitor =
        (rawMatch["awayteam"] as Record<string, unknown> | undefined) ??
        (rawMatch["visitorteam"] as Record<string, unknown> | undefined) ??
        {};
      const id = String(readField(rawMatch, "id", "@id") ?? "");
      const fixId = String(readField(rawMatch, "fix_id", "@fix_id") ?? id);
      const staticId = id || fixId;
      const homeTeam = String(readField(local, "name", "@name") ?? "Home");
      const awayTeam = String(readField(visitor, "name", "@name") ?? "Away");
      const status = String(
        readField(rawMatch, "status", "@status") ?? "Not Started",
      );
      const timer = String(readField(rawMatch, "timer", "@timer") ?? "");
      const date = String(
        readField(rawMatch, "date", "@formatted_date") ??
          readField(matchesContainer, "@formatted_date") ??
          "",
      );
      const time = String(readField(rawMatch, "time", "@time") ?? "");
      const scoreHome = parseScore(
        readField(local, "totalscore", "@goals", "goals", "@score", "score"),
      );
      const scoreAway = parseScore(
        readField(visitor, "totalscore", "@goals", "goals", "@score", "score"),
      );
      const key = staticId || fixId || `${homeTeam}-${awayTeam}-${date}`;

      if (!homeTeam || !awayTeam) continue;

      matches.push({
        key,
        staticId,
        fixId,
        leagueName,
        country,
        homeTeam,
        awayTeam,
        status,
        timer,
        scoreHome,
        scoreAway,
        periodScores: [],
        events: [],
        date,
        time,
        bucket,
      });
    }
  }

  return matches;
}

export function HockeyManager({ botName, metamaskAddress, onBack }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [todayMatches, setTodayMatches] = useState<HockeyFeedMatch[]>([]);
  const [tomorrowMatches, setTomorrowMatches] = useState<HockeyFeedMatch[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [polymarketInputByKey, setPolymarketInputByKey] = useState<
    Record<string, string>
  >({});
  const [savingSlugByKey, setSavingSlugByKey] = useState<
    Record<string, boolean>
  >({});
  const [savedSlugByKey, setSavedSlugByKey] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedKeys));
  }, [selectedKeys]);

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
        const games = payload.games ?? [];
        const keys = games.map((g) => g.key).filter(Boolean);
        if (keys.length > 0) setSelectedKeys(keys);

        const nextInputs: Record<string, string> = {};
        for (const game of games) {
          if (game.matchSlug) {
            nextInputs[game.key] = game.matchSlug;
          }
        }
        setPolymarketInputByKey(nextInputs);
      } catch {
        // local fallback remains active
      }
    };

    void loadPersisted();
    return () => {
      stopped = true;
    };
  }, [metamaskAddress]);

  useEffect(() => {
    let stopped = false;

    const load = async () => {
      if (!metamaskAddress) {
        setLoading(false);
        setError("Connect wallet to load hockey games");
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/orchestrator/users/${metamaskAddress}/bots/hockey-bot/discovery/world-championship`,
        );
        if (!res.ok) {
          throw new Error(`Discovery feed failed (${res.status})`);
        }
        const payload = (await res.json()) as {
          today?: unknown;
          tomorrow?: unknown;
        };

        if (stopped) return;

        const today = normalizeFeed(payload.today, "today");
        const tomorrow = normalizeFeed(payload.tomorrow, "tomorrow");
        const all = [...today, ...tomorrow];

        // Backend endpoint is strict World Championship only.
        const wcOnly = all;
        if (wcOnly.length === 0) {
          setError(
            "No World Championship matches returned by Goalserve right now",
          );
          return;
        }

        const rebucketed = rebucketByKickoffWindow(wcOnly);
        setTodayMatches(rebucketed.today);
        setTomorrowMatches(rebucketed.tomorrow);
      } catch (err) {
        if (!stopped) {
          setError(
            err instanceof Error ? err.message : "Failed to load hockey feed",
          );
        }
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [metamaskAddress]);

  const allMatches = useMemo(() => {
    return [...todayMatches, ...tomorrowMatches];
  }, [todayMatches, tomorrowMatches]);

  const byKey = useMemo(() => {
    const map: Record<string, HockeyFeedMatch> = {};
    for (const m of allMatches) map[m.key] = m;
    return map;
  }, [allMatches]);

  const persistSelection = async (
    keys: string[],
    slugInputMap: Record<string, string> = polymarketInputByKey,
  ): Promise<boolean> => {
    if (!metamaskAddress) return false;
    const games: WatchedGameDto[] = keys
      .map((key) => byKey[key])
      .filter((m): m is HockeyFeedMatch => Boolean(m))
      .map((m) => {
        const slug = extractMatchSlug(slugInputMap[m.key] ?? "");
        return {
          key: m.key,
          sport: "hockey",
          staticId: m.staticId,
          fixId: m.fixId,
          leagueName: m.leagueName,
          country: m.country,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          date: m.date,
          time: m.time,
          statusAtAdd: m.status,
          matchSlug: slug,
          createdAt: Date.now(),
        };
      });

    try {
      await fetch(
        `/api/orchestrator/users/${metamaskAddress}/bots/${BOT_NAME}/watched-games`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ games }),
        },
      );
      return true;
    } catch {
      // dashboard still works with local cache
      return false;
    }
  };

  const toggleGame = (key: string) => {
    setSelectedKeys((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      void persistSelection(next);
      return next;
    });
  };

  const removeGame = (key: string) => {
    setSelectedKeys((prev) => {
      const next = prev.filter((k) => k !== key);
      void persistSelection(next);
      return next;
    });
  };

  const onPolymarketInputChange = (key: string, value: string) => {
    setSavedSlugByKey((prev) => ({ ...prev, [key]: false }));
    setPolymarketInputByKey((prev) => {
      const next = { ...prev, [key]: value };
      if (selectedKeys.includes(key)) {
        void persistSelection(selectedKeys, next);
      }
      return next;
    });
  };

  const savePolymarketUrl = async (key: string) => {
    if (!selectedKeys.includes(key)) return;
    const nextMap = { ...polymarketInputByKey };
    setSavingSlugByKey((prev) => ({ ...prev, [key]: true }));
    const ok = await persistSelection(selectedKeys, nextMap);
    setSavingSlugByKey((prev) => ({ ...prev, [key]: false }));
    setSavedSlugByKey((prev) => ({ ...prev, [key]: ok }));
  };

  return (
    <div className="hky-shell">
      <div className="hky-header">
        <div className="hky-brand">goal.live</div>
        <div className="hky-filter-chip">ICE HOCKEY WC</div>
        <div className="hky-header-right">
          <button className="hky-small-btn" onClick={onBack}>
            Back
          </button>
        </div>
      </div>

      <div className="hky-layout">
        <aside className="hky-sidebar">
          <div className="hky-sidebar-title">Add Game</div>
          <div className="hky-sidebar-subtitle">
            {botName} · Goalserve hockey feed
          </div>

          {loading && <div className="hky-muted">Loading games...</div>}
          {error && <div className="hky-error">{error}</div>}

          <div className="hky-day-title">TODAY</div>
          {todayMatches.map((m) => {
            const added = selectedKeys.includes(m.key);
            return (
              <div key={`today-${m.key}`} className="hky-game-row-wrap">
                <button
                  className={`hky-game-row ${added ? "hky-game-row-added" : ""}`}
                  onClick={() => toggleGame(m.key)}
                >
                  <div className="hky-game-row-top">
                    <span className="hky-chip">
                      {m.status || "Not Started"}
                    </span>
                    <span className="hky-muted">{m.time} UTC</span>
                  </div>
                  <div className="hky-game-title">
                    {m.homeTeam} vs {m.awayTeam}
                  </div>
                  <div className="hky-game-id">
                    #{m.staticId || m.fixId || m.key}
                  </div>
                  <div className="hky-game-added">
                    {added ? "Added" : "Add"}
                  </div>
                </button>
                {added && (
                  <div className="hky-polymarket-box">
                    <label
                      className="hky-polymarket-label"
                      htmlFor={`poly-${m.key}`}
                    >
                      Polymarket URL or slug
                    </label>
                    <input
                      id={`poly-${m.key}`}
                      className="hky-polymarket-input"
                      placeholder="https://polymarket.com/sports/iihf/wch-svk-cze-2026-05-23"
                      value={polymarketInputByKey[m.key] ?? ""}
                      onChange={(e) =>
                        onPolymarketInputChange(m.key, e.target.value)
                      }
                      onBlur={() => {
                        void savePolymarketUrl(m.key);
                      }}
                    />
                    <div className="hky-polymarket-actions">
                      <button
                        className="hky-save-url-btn"
                        onClick={() => {
                          void savePolymarketUrl(m.key);
                        }}
                        disabled={savingSlugByKey[m.key] === true}
                      >
                        {savingSlugByKey[m.key] ? "Saving..." : "Save URL"}
                      </button>
                      {savedSlugByKey[m.key] ? (
                        <span className="hky-polymarket-saved">Saved</span>
                      ) : null}
                    </div>
                    <div className="hky-polymarket-hint">
                      Saved to bot as slug:{" "}
                      {extractMatchSlug(polymarketInputByKey[m.key] ?? "") ||
                        "(none yet)"}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="hky-day-title">TOMORROW</div>
          {tomorrowMatches.map((m) => {
            const added = selectedKeys.includes(m.key);
            return (
              <div key={`tomorrow-${m.key}`} className="hky-game-row-wrap">
                <button
                  className={`hky-game-row ${added ? "hky-game-row-added" : ""}`}
                  onClick={() => toggleGame(m.key)}
                >
                  <div className="hky-game-row-top">
                    <span className="hky-chip">
                      {m.status || "Not Started"}
                    </span>
                    <span className="hky-muted">{m.time} UTC</span>
                  </div>
                  <div className="hky-game-title">
                    {m.homeTeam} vs {m.awayTeam}
                  </div>
                  <div className="hky-game-id">
                    #{m.staticId || m.fixId || m.key}
                  </div>
                  <div className="hky-game-added">
                    {added ? "Added" : "Add"}
                  </div>
                </button>
                {added && (
                  <div className="hky-polymarket-box">
                    <label
                      className="hky-polymarket-label"
                      htmlFor={`poly-${m.key}`}
                    >
                      Polymarket URL or slug
                    </label>
                    <input
                      id={`poly-${m.key}`}
                      className="hky-polymarket-input"
                      placeholder="https://polymarket.com/sports/iihf/wch-svk-cze-2026-05-23"
                      value={polymarketInputByKey[m.key] ?? ""}
                      onChange={(e) =>
                        onPolymarketInputChange(m.key, e.target.value)
                      }
                      onBlur={() => {
                        void savePolymarketUrl(m.key);
                      }}
                    />
                    <div className="hky-polymarket-actions">
                      <button
                        className="hky-save-url-btn"
                        onClick={() => {
                          void savePolymarketUrl(m.key);
                        }}
                        disabled={savingSlugByKey[m.key] === true}
                      >
                        {savingSlugByKey[m.key] ? "Saving..." : "Save URL"}
                      </button>
                      {savedSlugByKey[m.key] ? (
                        <span className="hky-polymarket-saved">Saved</span>
                      ) : null}
                    </div>
                    <div className="hky-polymarket-hint">
                      Saved to bot as slug:{" "}
                      {extractMatchSlug(polymarketInputByKey[m.key] ?? "") ||
                        "(none yet)"}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        <main className="hky-main">
          <LiveManager
            botName="hockey-bot"
            selectedKeys={selectedKeys}
            baseByKey={byKey}
            metamaskAddress={metamaskAddress}
            onRemove={removeGame}
          />
        </main>
      </div>
    </div>
  );
}
