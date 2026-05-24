/**
 * goalserve.ts — Goalserve API client for live match polling.
 *
 * Rate limit: 1 req/s — never fire requests in parallel.
 * Endpoints used:
 *   hockey/home?json=1      — live fixtures and scores for hockey leagues
 */

import { config } from "./config.js";

const GOALSERVE_REQUEST_TIMEOUT_MS = parseInt(
  process.env["GOALSERVE_REQUEST_TIMEOUT_MS"] ?? "6000",
  10,
);

export interface MatchState {
  staticId: string;
  /** "19:00" pre-game | "HT" half-time | "FT" full-time | "45" live minute */
  status: string;
  minute: string;
  /** NaN before kickoff (goals = "?") */
  scoreHome: number;
  scoreAway: number;
  teamHome: string;
  teamAway: string;
}

type MatchNode = Record<string, unknown>;

function normalizeTeamName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTeamAliases(team: string): string[] {
  const normalized = normalizeTeamName(team);
  const aliases = new Set<string>([normalized]);
  aliases.add(
    normalized
      .replace(/\brepublic\b/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  if (normalized === "czech republic") aliases.add("czechia");
  if (normalized === "czechia") aliases.add("czech republic");
  if (normalized === "slovak republic") aliases.add("slovakia");
  if (normalized === "united states") {
    aliases.add("usa");
    aliases.add("us");
  }

  return Array.from(aliases).filter(Boolean);
}

function teamNameMatches(feedName: string, requestedTeam: string): boolean {
  const n = normalizeTeamName(feedName);
  const aliases = buildTeamAliases(requestedTeam);
  return aliases.some((a) => n.includes(a));
}

async function gsGet(path: string): Promise<unknown> {
  const url = `${config.goalserve.baseUrl}/${config.goalserve.apiKey}/${path}`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(GOALSERVE_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Goalserve ${res.status}: ${path}`);
      return await res.json();
    } catch (err) {
      const message = (err as Error).message;
      const isRetryable =
        message.includes("aborted due to timeout") ||
        message.includes("Unterminated string in JSON") ||
        message.includes("Unexpected end of JSON input");

      if (attempt < 2 && isRetryable) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Goalserve request failed after retries: ${path}`);
}

/**
 * Recursively search the Goalserve JSON for a match node containing teamA and teamB.
 * Returns the @static_id if found, otherwise null.
 * Handles the unpredictable nesting of the home feed response.
 */
function findMatchNodeRecursive(
  node: unknown,
  teamA: string,
  teamB: string,
): MatchNode | null {
  if (typeof node !== "object" || node === null) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const result = findMatchNodeRecursive(item, teamA, teamB);
      if (result) return result;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  // Check if this IS a match node (has both localteam and visitorteam)
  const local = obj["localteam"] as Record<string, unknown> | undefined;
  const visitor = obj["visitorteam"] as Record<string, unknown> | undefined;

  if (local && visitor) {
    const localName = String(local["@name"] ?? "");
    const visitorName = String(visitor["@name"] ?? "");

    const isMatch =
      (teamNameMatches(localName, teamA) &&
        teamNameMatches(visitorName, teamB)) ||
      (teamNameMatches(localName, teamB) &&
        teamNameMatches(visitorName, teamA));

    if (isMatch) {
      return obj;
    }
  }

  // Recurse into all child properties
  for (const value of Object.values(obj)) {
    const result = findMatchNodeRecursive(value, teamA, teamB);
    if (result) return result;
  }

  return null;
}

/**
 * Fetch today's home feed and return the @static_id for the configured match.
 * Teams are read from config.matchTeamHome / config.matchTeamAway.
 * Falls back to GOALSERVE_MATCH_STATIC_ID env var if not found in feed.
 */
export async function findMatchStaticId(): Promise<string> {
  const home = config.matchTeamHome;
  const away = config.matchTeamAway;
  try {
    const data = await gsGet("hockey/home?json=1");
    const matchNode = findMatchNodeRecursive(data, home, away);
    const staticId =
      (matchNode?.["@static_id"] as string | undefined) ??
      (matchNode?.["@id"] as string | undefined);
    if (staticId) {
      console.log(
        `[goalserve] Found ${home} vs ${away}: static_id=${staticId}`,
      );
      return staticId;
    }
    console.warn(
      `[goalserve] ${home} vs ${away} not found in hockey/home feed`,
    );
  } catch (err) {
    console.error("[goalserve] Home feed error:", (err as Error).message);
  }

  // Fallback to env var
  const fallback = config.goalserve.matchStaticId;
  if (fallback) {
    console.log(`[goalserve] Using fallback static_id=${fallback} from env`);
    return fallback;
  }

  throw new Error(
    `Could not find ${home} vs ${away} static_id. ` +
      "Set GOALSERVE_MATCH_STATIC_ID in .env as a fallback.",
  );
}

export async function findMatchStaticIdForTeams(
  homeTeam: string,
  awayTeam: string,
): Promise<string> {
  const home = homeTeam.trim();
  const away = awayTeam.trim();
  try {
    const data = await gsGet("hockey/home?json=1");
    const matchNode = findMatchNodeRecursive(data, home, away);
    const staticId =
      (matchNode?.["@static_id"] as string | undefined) ??
      (matchNode?.["@id"] as string | undefined);
    if (staticId) {
      console.log(
        `[goalserve] Found ${home} vs ${away}: static_id=${staticId}`,
      );
      return staticId;
    }
    console.warn(
      `[goalserve] ${home} vs ${away} not found in hockey/home feed`,
    );
  } catch (err) {
    console.error("[goalserve] Home feed error:", (err as Error).message);
  }

  const fallback = config.goalserve.matchStaticId;
  if (fallback) {
    console.log(`[goalserve] Using fallback static_id=${fallback} from env`);
    return fallback;
  }

  throw new Error(
    `Could not find ${home} vs ${away} static_id. ` +
      "Set GOALSERVE_MATCH_STATIC_ID in .env as a fallback.",
  );
}

/**
 * Poll a live match for current score and status.
 */
export async function pollLiveMatch(
  staticId: string,
  homeTeam?: string,
  awayTeam?: string,
  fallbackId?: string,
): Promise<MatchState | null> {
  try {
    const data = await gsGet("hockey/home?json=1");

    let matchNode: MatchNode | null = null;

    if (staticId) {
      const wantedIds = new Set(
        [staticId, fallbackId]
          .map((v) => String(v ?? "").trim())
          .filter((v) => v.length > 0),
      );

      const parseScore = (value: unknown): number =>
        parseInt(String(value ?? ""), 10);

      const nodeRank = (obj: MatchNode): number => {
        const local = obj["localteam"] as Record<string, unknown> | undefined;
        const visitor =
          (obj["visitorteam"] as Record<string, unknown> | undefined) ??
          (obj["awayteam"] as Record<string, unknown> | undefined);
        const status = String(obj["@status"] ?? "").trim();
        const timer = String(obj["@timer"] ?? "").trim();

        const scoreHome = parseScore(
          local?.["@goals"] ?? local?.["@score"] ?? local?.["goals"] ?? "",
        );
        const scoreAway = parseScore(
          visitor?.["@goals"] ?? visitor?.["@score"] ?? visitor?.["goals"] ?? "",
        );

        const hasScore = Number.isFinite(scoreHome) && Number.isFinite(scoreAway);
        const hasRunningClock = /^\d+/.test(timer) || /^\d+/.test(status);
        const looksPreKickoffClock = /^\d{1,2}:\d{2}$/.test(status);

        let rank = 0;
        if (hasScore) rank += 4;
        if (hasRunningClock) rank += 2;
        if (!looksPreKickoffClock) rank += 1;
        return rank;
      };

      const findById = (node: unknown): MatchNode | null => {
        if (typeof node !== "object" || node === null) return null;
        if (Array.isArray(node)) {
          let best: MatchNode | null = null;
          for (const item of node) {
            const found = findById(item);
            if (!found) continue;
            if (!best || nodeRank(found) > nodeRank(best)) {
              best = found;
            }
          }
          return best;
        }
        const obj = node as MatchNode;
        const id = String(obj["@static_id"] ?? obj["@id"] ?? "");
        if (
          wantedIds.has(id) &&
          obj["localteam"] &&
          (obj["visitorteam"] || obj["awayteam"])
        ) {
          return obj;
        }
        let best: MatchNode | null = null;
        for (const v of Object.values(obj)) {
          const found = findById(v);
          if (!found) continue;
          if (!best || nodeRank(found) > nodeRank(best)) {
            best = found;
          }
        }
        return best;
      };

      matchNode = findById(data);
    }

    if (!matchNode) {
      const resolvedHome =
        (homeTeam && homeTeam.trim()) || config.matchTeamHome;
      const resolvedAway =
        (awayTeam && awayTeam.trim()) || config.matchTeamAway;
      matchNode = findMatchNodeRecursive(data, resolvedHome, resolvedAway);
    }

    if (!matchNode || typeof matchNode !== "object") return null;

    const m = matchNode as Record<string, unknown>;
    const local = m["localteam"] as Record<string, unknown> | undefined;
    const visitor =
      (m["visitorteam"] as Record<string, unknown> | undefined) ??
      (m["awayteam"] as Record<string, unknown> | undefined);
    const scoreHomeRaw =
      local?.["@goals"] ?? local?.["@score"] ?? local?.["goals"] ?? "?";
    const scoreAwayRaw =
      visitor?.["@goals"] ?? visitor?.["@score"] ?? visitor?.["goals"] ?? "?";

    return {
      staticId:
        String(m["@static_id"] ?? m["@id"] ?? staticId) ||
        config.goalserve.matchStaticId,
      status: String(m["@status"] ?? ""),
      minute: String(m["@timer"] ?? ""),
      scoreHome: parseInt(String(scoreHomeRaw), 10),
      scoreAway: parseInt(String(scoreAwayRaw), 10),
      teamHome: String(local?.["@name"] ?? "Home"),
      teamAway: String(visitor?.["@name"] ?? "Away"),
    };
  } catch (err) {
    console.error("[goalserve] pollLiveMatch error:", (err as Error).message);
    return null;
  }
}

/** Returns true when the status string indicates the game is currently live (not pre-game, HT between halves, or FT). */
export function isLiveStatus(status: string): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (
    status === "FT" ||
    status === "AET" ||
    status === "Postp." ||
    status === "Canc." ||
    s === "not started" ||
    s === "cancelled" ||
    s === "postponed"
  )
    return false;
  // Text-form statuses Goalserve returns during play
  if (
    s === "ht" ||
    s === "half-time" ||
    s === "1st period" ||
    s === "2nd period" ||
    s === "3rd period" ||
    s === "first period" ||
    s === "second period" ||
    s === "third period" ||
    s === "q1" ||
    s === "q2" ||
    s === "q3" ||
    s === "q4" ||
    s === "1p" ||
    s === "2p" ||
    s === "3p" ||
    s === "ot" ||
    s === "first half" ||
    s === "second half" ||
    s === "in progress" ||
    s === "live"
  )
    return true;
  if (s.includes("period") && !s.includes("intermission")) return true;
  // Numeric minute: "1" .. "90" or "45+2" etc
  return /^\d/.test(status);
}

export function isFullTime(status: string): boolean {
  const s = status.toLowerCase();
  return (
    status === "FT" ||
    status === "AET" ||
    status === "Final" ||
    s === "final" ||
    s === "final/ot" ||
    s === "after penalties" ||
    s === "after shootout" ||
    s === "full time" ||
    s === "full-time" || // Goalserve hyphenated form (mirrors "Half-time")
    s === "finished" ||
    s === "ended" ||
    s === "after extra time"
  );
}
