/**
 * lag-scanner.ts — Resolution Lag Opportunity Observer
 *
 * Scans for markets where Gamma has resolved but the CLOB has not yet
 * settled. Records every opportunity with timing data — how long the
 * lag window stayed open, best yield available, when the CLOB caught up.
 *
 * No trades are placed. No private key required.
 *
 * Run: cd bots/resolution-lag && npx tsx scripts/lag-scanner.ts
 * Stop early: Ctrl+C — report is printed and saved on exit.
 */

const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const CLOB_API = "https://clob.polymarket.com";

const SCAN_DURATION_MS =
  parseInt(process.env["SCAN_HOURS"] ?? "3") * 60 * 60 * 1_000;
const POLL_INTERVAL_MS =
  parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "120") * 1_000;

// Consider CLOB settled when ask >= this threshold
const SETTLED_THRESHOLD = 0.99;
// Ignore markets where ask is already >= this (already settled or live pricing)
const LIVE_MARKET_THRESHOLD = 0.985;
// Minimum expected yield to record as an "opportunity"
const MIN_YIELD = 0.003;

// -- Types --------------------------------------------------------------------

interface AskSnapshot {
  t: string;   // ISO timestamp
  ask: number;
}

interface Opportunity {
  conditionId: string;
  question: string;
  winnerTokenId: string;
  gammaWinner: string;         // "Yes" / "No" / other
  endDateIso: string;
  firstSeenAt: string;         // wall-clock when we detected Gamma resolved
  snapshots: AskSnapshot[];    // CLOB ask price over time
  settledAt: string | null;    // when CLOB ask first hit >= SETTLED_THRESHOLD
  lagMs: number | null;        // settledAt - firstSeenAt in ms
  // derived
  initialAsk: number;
  minAsk: number;              // best buying opportunity seen
  maxYield: number;            // (1 - minAsk) / minAsk
}

// -- Gamma API ----------------------------------------------------------------

interface GammaToken {
  token_id: string;
  outcome: string;
}

interface GammaMarket {
  id: string;
  conditionId?: string;
  condition_id?: string;
  question: string;
  resolved: boolean;
  winner?: string;
  tokens?: GammaToken[];
  end_date_iso?: string;
}

function normalizeLabel(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapWinnerTokenId(
  winner: string,
  tokens: GammaToken[],
): string | null {
  if (!winner || !tokens.length) return null;
  const nw = normalizeLabel(winner);
  for (const t of tokens) {
    if (normalizeLabel(t.outcome) === nw) return t.token_id;
  }
  for (const t of tokens) {
    const no = normalizeLabel(t.outcome);
    if (no.includes(nw) || nw.includes(no)) return t.token_id;
  }
  return null;
}

async function fetchGammaResolved(): Promise<GammaMarket[]> {
  const url = `${GAMMA_API}?closed=true&active=false&resolved=true&limit=200`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gamma ${res.status}`);
  const data = (await res.json()) as GammaMarket[];
  return Array.isArray(data) ? data : [];
}

// -- CLOB API (anonymous, read-only) ------------------------------------------

interface ClobBook {
  asks: Array<{ price: string; size: string }>;
  bids: Array<{ price: string; size: string }>;
}

async function getClobBestAsk(tokenId: string): Promise<number> {
  try {
    const res = await fetch(
      `${CLOB_API}/book?token_id=${tokenId}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return 0;
    const book = (await res.json()) as ClobBook;
    const asks = (book.asks ?? [])
      .map((a) => parseFloat(a.price))
      .filter(Boolean);
    if (!asks.length) return 0;
    return Math.min(...asks);
  } catch {
    return 0;
  }
}

interface ClobMarketInfo {
  active?: boolean;
  accepting_orders?: boolean;
  tokens?: Array<{ token_id: string; winner?: boolean }>;
}

async function isClobSettled(conditionId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${CLOB_API}/markets/${conditionId}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return false;
    const m = (await res.json()) as ClobMarketInfo;
    return !m.active && !m.accepting_orders;
  } catch {
    return false;
  }
}

// -- State --------------------------------------------------------------------

const opportunities = new Map<string, Opportunity>(); // tokenId -> Opportunity
let pollCount = 0;
const startedAt = new Date();

// -- Poll ---------------------------------------------------------------------

async function poll(): Promise<void> {
  pollCount++;
  const now = new Date().toISOString();
  console.log(`\n[poll #${pollCount}] ${now}`);

  let gammaMarkets: GammaMarket[] = [];
  try {
    gammaMarkets = await fetchGammaResolved();
    console.log(`  Gamma: ${gammaMarkets.length} resolved markets`);
  } catch (err) {
    console.warn(`  Gamma error: ${(err as Error).message}`);
    return;
  }

  for (const gm of gammaMarkets) {
    if (!gm.winner) continue;
    const conditionId = gm.conditionId ?? gm.condition_id ?? "";
    if (!conditionId) continue;

    const tokenId = mapWinnerTokenId(gm.winner, gm.tokens ?? []);
    if (!tokenId) continue;

    const ask = await getClobBestAsk(tokenId);
    if (ask <= 0) continue;

    const alreadySettled =
      ask >= SETTLED_THRESHOLD || (await isClobSettled(conditionId));

    // -- New opportunity ------------------------------------------------------
    if (!opportunities.has(tokenId)) {
      if (alreadySettled) continue;
      if (ask >= LIVE_MARKET_THRESHOLD) continue;
      const yld = (1 - ask) / ask;
      if (yld < MIN_YIELD) continue;

      const opp: Opportunity = {
        conditionId,
        question: gm.question,
        winnerTokenId: tokenId,
        gammaWinner: gm.winner,
        endDateIso: gm.end_date_iso ?? "",
        firstSeenAt: now,
        snapshots: [{ t: now, ask }],
        settledAt: null,
        lagMs: null,
        initialAsk: ask,
        minAsk: ask,
        maxYield: yld,
      };
      opportunities.set(tokenId, opp);
      console.log(
        `  NEW  "${gm.question.slice(0, 60)}"` +
          `\n       winner=${gm.winner}  ask=$${ask.toFixed(4)}  yield=${(yld * 100).toFixed(2)}%`,
      );
      continue;
    }

    // -- Update existing opportunity ------------------------------------------
    const opp = opportunities.get(tokenId)!;
    if (opp.settledAt) continue;

    opp.snapshots.push({ t: now, ask });
    if (ask < opp.minAsk) {
      opp.minAsk = ask;
      opp.maxYield = (1 - ask) / ask;
    }

    if (alreadySettled) {
      opp.settledAt = now;
      opp.lagMs =
        new Date(now).getTime() - new Date(opp.firstSeenAt).getTime();
      const lagMin = (opp.lagMs / 60_000).toFixed(1);
      console.log(
        `  SETTLED "${gm.question.slice(0, 55)}"` +
          `  lag=${lagMin}m  maxYield=${(opp.maxYield * 100).toFixed(2)}%`,
      );
    } else {
      const openMins = (
        (Date.now() - new Date(opp.firstSeenAt).getTime()) /
        60_000
      ).toFixed(1);
      console.log(
        `  OPEN  "${gm.question.slice(0, 55)}"` +
          `  ask=$${ask.toFixed(4)}  open=${openMins}m`,
      );
    }
  }
}

// -- Report -------------------------------------------------------------------

function fmtMs(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (mins === 0) return `${secs}s`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function printReport(): void {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();

  const all = [...opportunities.values()];
  const settled = all.filter((o) => o.settledAt !== null);
  const open = all.filter((o) => o.settledAt === null);

  console.log("\n");
  console.log("=".repeat(70));
  console.log("  RESOLUTION LAG SCANNER -- REPORT");
  console.log("=".repeat(70));
  console.log(`  Start    : ${startedAt.toISOString()}`);
  console.log(`  End      : ${endedAt.toISOString()}`);
  console.log(`  Duration : ${fmtMs(durationMs)}   Polls: ${pollCount}`);
  console.log(`  Opportunities observed : ${all.length}`);
  console.log(`    Settled during scan  : ${settled.length}`);
  console.log(`    Still open at end    : ${open.length}`);
  console.log("-".repeat(70));

  if (all.length === 0) {
    console.log("  No opportunities detected during this scan window.");
  }

  if (settled.length > 0) {
    console.log("\n  SETTLED OPPORTUNITIES\n");
    settled.sort((a, b) => (a.lagMs ?? 0) - (b.lagMs ?? 0));
    for (const o of settled) {
      console.log(`  > ${o.question}`);
      console.log(
        `    Winner: ${o.gammaWinner}   Condition: ${o.conditionId.slice(0, 14)}...`,
      );
      console.log(
        `    First seen  : ${o.firstSeenAt}   Initial ask: $${o.initialAsk.toFixed(4)}`,
      );
      console.log(
        `    Settled at  : ${o.settledAt}   Lag: ${fmtMs(o.lagMs!)}`,
      );
      console.log(
        `    Min ask     : $${o.minAsk.toFixed(4)}   Max yield: ${(o.maxYield * 100).toFixed(2)}%   Snapshots: ${o.snapshots.length}`,
      );
      console.log();
    }

    const lags = settled.map((o) => o.lagMs!);
    const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;
    const sortedLags = [...lags].sort((a, b) => a - b);
    const medianLag = sortedLags[Math.floor(sortedLags.length / 2)]!;
    const avgYield =
      settled.reduce((a, o) => a + o.maxYield, 0) / settled.length;

    console.log("  STATISTICS (settled opportunities)");
    console.log(`    Avg lag    : ${fmtMs(avgLag)}`);
    console.log(`    Median lag : ${fmtMs(medianLag)}`);
    console.log(`    Max lag    : ${fmtMs(Math.max(...lags))}`);
    console.log(`    Avg max yield : ${(avgYield * 100).toFixed(2)}%`);
  }

  if (open.length > 0) {
    console.log("\n  STILL OPEN AT END OF SCAN\n");
    for (const o of open) {
      const openMs =
        endedAt.getTime() - new Date(o.firstSeenAt).getTime();
      const lastAsk = o.snapshots.at(-1)?.ask ?? o.initialAsk;
      console.log(`  > ${o.question}`);
      console.log(
        `    First seen: ${o.firstSeenAt}   Open for: ${fmtMs(openMs)}`,
      );
      console.log(
        `    Last ask: $${lastAsk.toFixed(4)}   Max yield seen: ${(o.maxYield * 100).toFixed(2)}%   Snapshots: ${o.snapshots.length}`,
      );
      console.log();
    }
  }

  console.log("=".repeat(70));

  // Save JSON
  const reportPath = `scripts/lag-report-${startedAt.toISOString().slice(0, 16).replace(/:/g, "-")}.json`;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          meta: {
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs,
            pollCount,
            pollIntervalMs: POLL_INTERVAL_MS,
            settledThreshold: SETTLED_THRESHOLD,
            minYield: MIN_YIELD,
          },
          opportunities: all,
        },
        null,
        2,
      ),
    );
    console.log(`\n  JSON report saved: ${reportPath}`);
  } catch (err) {
    console.warn("  Could not save JSON report:", (err as Error).message);
  }
}

// -- Main loop ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("  Resolution Lag Scanner -- READ-ONLY, no trades placed");
  console.log(
    `  Duration : ${SCAN_DURATION_MS / 3_600_000}h   Poll every: ${POLL_INTERVAL_MS / 1_000}s`,
  );
  console.log(
    `  Thresholds: settled>=$${SETTLED_THRESHOLD}  ignore-live>=$${LIVE_MARKET_THRESHOLD}  min-yield=${(MIN_YIELD * 100).toFixed(1)}%`,
  );
  console.log("=".repeat(70));

  process.on("SIGINT", () => {
    console.log("\n\n[scanner] SIGINT -- generating report...");
    printReport();
    process.exit(0);
  });

  const deadline = Date.now() + SCAN_DURATION_MS;

  while (Date.now() < deadline) {
    await poll();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(POLL_INTERVAL_MS, remaining);
    await new Promise((r) => setTimeout(r, wait));
  }

  printReport();
}

main().catch((err) => {
  console.error("[scanner] Fatal:", err);
  process.exit(1);
});
