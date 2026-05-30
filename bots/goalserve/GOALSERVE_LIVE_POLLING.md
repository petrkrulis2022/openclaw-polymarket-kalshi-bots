# Goalserve Live Event Polling — How This Project Uses It

## Overview

We use Goalserve as our real-time soccer data provider. The integration has two phases:

1. **Discover today's fixtures** — via the `soccernew/home` feed
2. **Poll each live match for score and stat changes** — via the `commentaries/match` endpoint

The polling script is at `scripts/poll-live-matches.mjs`. Run it with:

```bash
node scripts/poll-live-matches.mjs
```

---

## Credentials

| Setting    | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| API Key    | `edc0ecd4f73c4c1a20f808dea8e5ebf2`                         |
| Base URL   | `https://www.goalserve.com/getfeed`                        |
| Rate limit | **1 request per second** — never fire requests in parallel |

Add `?json=1` to any feed URL to get JSON instead of XML.

---

## Step 1 — Find Today's Fixtures (`soccernew/home`)

**Endpoint:**

```
GET http://www.goalserve.com/getfeed/{API_KEY}/soccernew/home?json=1
```

Returns all leagues with today's scheduled, live, and finished matches. Each match object contains:

```json
{
  "@status": "19:00", // kick-off time if not started; "HT", "FT", or live minute "67" if in progress
  "@timer": "67", // live minute when in play
  "@static_id": "3682703", // ← KEY: use this to poll the match individually
  "@fix_id": "4190084",
  "@id": "6874532",
  "@commentary_available": "1204", // non-empty = live stats available
  "@coveredLive": "True",
  "@venue": "Emirates Stadium",
  "localteam": { "@name": "Arsenal", "@goals": "?", "@id": "9002" },
  "visitorteam": { "@name": "Burnley", "@goals": "?", "@id": "9072" }
}
```

> `@goals` is `"?"` before kick-off and becomes a number once the game starts.

**League IDs we support** (stored in `odds_api_config.goalserve_league` in Supabase or mapped from `odds_api_config.sport`):

| League                   | Goalserve ID |
| ------------------------ | ------------ |
| Premier League           | `1204`       |
| UEFA Champions League    | `1005`       |
| UEFA Europa League       | `1007`       |
| Bundesliga               | `1229`       |
| La Liga                  | `1399`       |
| Serie A                  | `1269`       |
| Ligue 1                  | `1221`       |
| Europa Conference League | `18853`      |

---

## Step 2 — Poll a Single Live Match (`commentaries/match`)

Once a match is live, we call the individual match commentary endpoint using its `@static_id`:

**Endpoint:**

```
GET https://www.goalserve.com/getfeed/{API_KEY}/commentaries/match?id={STATIC_ID}&league={LEAGUE_ID}&json=1
```

Example (Arsenal home match):

```
https://www.goalserve.com/getfeed/edc0ecd4f73c4c1a20f808dea8e5ebf2/commentaries/match?id=3682703&league=1204&json=1
```

### Response structure

The root path to the match node is:

```
data.commentaries.tournament.match   // OR
data.commentaries.match              // fallback
```

Extract score and status like this:

```js
const scoreHome = parseInt(matchNode?.localteam?.["@goals"], 10);
const scoreAway = parseInt(matchNode?.visitorteam?.["@goals"], 10);
const status = matchNode?.["@status"]; // "HT", "FT", "67", etc.
const minute = matchNode?.["@timer"]; // live minute string
```

### Goals detection

We compare the newly fetched `scoreHome` / `scoreAway` against the last known values stored in Supabase:

```js
if (scoreHome !== prevScoreHome || scoreAway !== prevScoreAway) {
  // GOAL detected — update Supabase
  await sbFetch(`/matches?id=eq.${matchId}`, {
    method: "PATCH",
    body: { score_home: scoreHome, score_away: scoreAway },
  });
  console.log(
    `*** GOAL: ${prevScoreHome}-${prevScoreAway} → ${scoreHome}-${scoreAway} ***`,
  );
}
```

There is **no webhook** — this is pure polling. A goal is detected when the score number increases between two consecutive polls.

### Corners detection (same pattern as goals)

Corner counts live inside `matchNode.stats`:

```js
// Goalserve format (preferred):
const cornersHome = parseInt(
  matchNode.stats?.localteam?.corners?.["@total"],
  10,
);
const cornersAway = parseInt(
  matchNode.stats?.visitorteam?.corners?.["@total"],
  10,
);

// Legacy/fallback paths (also checked):
matchNode.stats?.corners?.["@localteam"];
matchNode.stats?.corners?.["@home"];
matchNode.stats?.localteam?.["@corners"];
```

When the total corner count increases, we attribute each new corner to home or away using a simple cumulative model:

- Corners `1 … cornersHome` = home
- Corners `cornersHome+1 … total` = away

This lets us settle bets per-corner without double-settling.

---

## Step 3 — Polling Loop

The script runs a loop every **60 seconds**:

```
poll()         ← runs immediately at startup
setInterval(poll, 60_000)
```

Each tick:

1. Fetches all matches with `status = 'live'` from Supabase
2. For each match, calls `commentaries/match` with its `static_id` and `gsLeague`
3. Compares score and corners against stored values
4. Patches Supabase if anything changed
5. Settles any corner bets triggered by new corner events

Matches without a `goalserve_static_id` stored in Supabase are skipped.

---

## Supabase Match Row — Relevant Columns

| Column                          | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `goalserve_static_id`           | Goalserve `@static_id` — required to call `commentaries/match`                    |
| `status`                        | `'live'`, `'finished'`, `'cancelled'`, etc. Only `'live'` rows are polled         |
| `score_home` / `score_away`     | Last known score — updated on goal detection                                      |
| `corners_home` / `corners_away` | Last known corner count                                                           |
| `corners_last_settled`          | Total corners settled so far — prevents double-settling                           |
| `odds_api_config`               | JSON: contains `sport` key and optionally `goalserve_league` for league ID lookup |

---

## Additional Feeds Available

| Feed                               | URL pattern                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| All today's matches                | `.../soccernew/home?json=1`                                                          |
| Live games only                    | `http://livescore.goalserve.com/api/v1/soccer/live?apiKey={KEY}`                     |
| Yesterday's results                | `.../soccernew/d-1?json=1`                                                           |
| Full PL fixtures (season)          | `.../soccerfixtures/leagueid/1204?json=1`                                            |
| League standings                   | `.../standings/1204.xml?json=1`                                                      |
| Predicted lineups (1-2 days ahead) | `.../commentaries/1204_predicted.xml?json=1`                                         |
| Live heatmap (top leagues)         | `.../commentaries/1204_heatmap.xml?json=1`                                           |
| League logo                        | `http://data2.goalserve.com:8084/api/v1/logotips/soccer/leagues?k={KEY}&ids=1204`    |
| Team logo                          | `http://data2.goalserve.com:8084/api/v1/logotips/soccer/teams?k={KEY}&ids=9002,9072` |

---

## Key Gotchas

1. **Rate limit is 1 req/s** — always `await` each fetch sequentially, never `Promise.all` multiple Goalserve calls.
2. **`@static_id` ≠ `@id`** — use `@static_id` from the home feed to call `commentaries/match`. The `@id` is a session ID that changes.
3. **Goal detection is poll-based** — if the server is down for 2 minutes and two goals are scored, we'll see the combined change on the next tick. The score delta can be >1.
4. **`@goals` is `"?"` before kick-off** — always parse with `parseInt`; NaN from `"?"` should fall back to the stored score.
5. **JSON response depth varies** — the match node can be at `commentaries.tournament.match` or `commentaries.match` depending on the league. Always try both paths.
6. **`commentary_available` attribute** — in the `soccernew/home` feed, a non-empty `@commentary_available` value means live per-match stats are available for that match. The value is the league ID.
