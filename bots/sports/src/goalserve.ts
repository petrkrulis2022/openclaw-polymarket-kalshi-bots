/**
 * goalserve.ts — Goalserve API client for live match polling.
 *
 * Rate limit: 1 req/s — never fire requests in parallel.
 * Endpoints used:
 *   soccernew/home          — find today's fixtures, get @static_id
 *   commentaries/match      — live score + status for a specific match
 */

import { config } from "./config.js";

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

async function gsGet(path: string): Promise<unknown> {
  const url = `${config.goalserve.baseUrl}/${config.goalserve.apiKey}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Goalserve ${res.status}: ${path}`);
  return res.json();
}

/**
 * Recursively search the Goalserve JSON for a match node containing teamA and teamB.
 * Returns the @static_id if found, otherwise null.
 * Handles the unpredictable nesting of the home feed response.
 */
function findStaticIdRecursive(
  node: unknown,
  teamA: string,
  teamB: string,
): string | null {
  if (typeof node !== "object" || node === null) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const result = findStaticIdRecursive(item, teamA, teamB);
      if (result) return result;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  // Check if this IS a match node (has both localteam and visitorteam)
  const local = obj["localteam"] as Record<string, unknown> | undefined;
  const visitor = obj["visitorteam"] as Record<string, unknown> | undefined;

  if (local && visitor) {
    const localName = String(local["@name"] ?? "").toLowerCase();
    const visitorName = String(visitor["@name"] ?? "").toLowerCase();
    const a = teamA.toLowerCase();
    const b = teamB.toLowerCase();

    const isMatch =
      (localName.includes(a) && visitorName.includes(b)) ||
      (localName.includes(b) && visitorName.includes(a));

    if (isMatch) {
      const staticId = obj["@static_id"] as string | undefined;
      if (staticId) return staticId;
    }
  }

  // Recurse into all child properties
  for (const value of Object.values(obj)) {
    const result = findStaticIdRecursive(value, teamA, teamB);
    if (result) return result;
  }

  return null;
}

/**
 * Fetch today's home feed and return the @static_id for the Arsenal vs Burnley match.
 * Falls back to GOALSERVE_MATCH_STATIC_ID env var if not found in feed.
 */
export async function findArsenalBurnleyStaticId(): Promise<string> {
  try {
    const data = await gsGet("soccernew/home?json=1");
    const staticId = findStaticIdRecursive(data, "Arsenal", "Burnley");
    if (staticId) {
      console.log(
        `[goalserve] Found Arsenal vs Burnley: static_id=${staticId}`,
      );
      return staticId;
    }
    console.warn(
      "[goalserve] Arsenal vs Burnley not found in home feed — match may not be listed yet",
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
    "Could not find Arsenal vs Burnley static_id. " +
      "Set GOALSERVE_MATCH_STATIC_ID in .env as a fallback.",
  );
}

/**
 * Poll a live match for current score and status.
 */
export async function pollLiveMatch(
  staticId: string,
): Promise<MatchState | null> {
  try {
    const data = await gsGet(
      `commentaries/match?id=${staticId}&league=${config.goalserve.leagueId}&json=1`,
    );

    // Navigate to match node — two possible paths
    const commentaries = (data as Record<string, unknown>)?.["commentaries"];
    if (!commentaries || typeof commentaries !== "object") return null;

    const c = commentaries as Record<string, unknown>;

    // Path 1: commentaries.tournament.match
    // Path 2: commentaries.match
    const tournament = c["tournament"] as Record<string, unknown> | undefined;
    const matchNode =
      (tournament?.["match"] as Record<string, unknown> | undefined) ??
      (c["match"] as Record<string, unknown> | undefined);

    if (!matchNode || typeof matchNode !== "object") return null;

    const m = matchNode as Record<string, unknown>;
    const local = m["localteam"] as Record<string, unknown> | undefined;
    const visitor = m["visitorteam"] as Record<string, unknown> | undefined;

    return {
      staticId,
      status: String(m["@status"] ?? ""),
      minute: String(m["@timer"] ?? ""),
      scoreHome: parseInt(String(local?.["@goals"] ?? "?"), 10),
      scoreAway: parseInt(String(visitor?.["@goals"] ?? "?"), 10),
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
    s === "first half" ||
    s === "second half" ||
    s === "in progress" ||
    s === "live"
  )
    return true;
  // Numeric minute: "1" .. "90" or "45+2" etc
  return /^\d/.test(status);
}

export function isFullTime(status: string): boolean {
  const s = status.toLowerCase();
  return (
    status === "FT" ||
    status === "AET" ||
    s === "full time" ||
    s === "full-time" ||    // Goalserve hyphenated form (mirrors "Half-time")
    s === "finished" ||
    s === "ended" ||
    s === "after extra time"
  );
}
