export interface GammaTeams {
  home: string;
  away: string;
}

export async function fetchTeamsFromSlug(slug: string): Promise<GammaTeams | null> {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
    );
    if (!res.ok) return null;
    const events = (await res.json()) as Array<Record<string, unknown>>;
    const event = events[0];
    if (!event) return null;

    // Try event title: "Team A vs Team B" or "Team A - Team B"
    const title = String(event["title"] ?? event["name"] ?? "");
    const vsMatch = title.match(
      /^(.+?)\s+(?:vs?\.?\s+|-\s+|–\s+)(.+?)(?:\s+on\s+|\s*\d|$)/i,
    );
    if (vsMatch?.[1] && vsMatch?.[2]) {
      return { home: vsMatch[1].trim(), away: vsMatch[2].trim() };
    }

    // Fallback: parse market questions "Will X win..."
    const markets = Array.isArray(event["markets"])
      ? (event["markets"] as Array<Record<string, unknown>>)
      : [];
    const teams: string[] = [];
    for (const market of markets) {
      const q = String(market["question"] ?? "");
      const m = q.match(/^Will (.+?) win/i);
      if (m?.[1]) teams.push(m[1].trim());
    }
    if (teams.length >= 2) return { home: teams[0], away: teams[1] };
    if (teams.length === 1) return { home: teams[0], away: "" };

    return null;
  } catch {
    return null;
  }
}
