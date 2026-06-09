/**
 * learn.ts — self-learning parameter tuner for the resolution-lag bot.
 *
 * Analyses resolved positions to tune minYieldPct, monitorIntervalMs, and a
 * category blocklist. Overrides are applied at runtime without a restart and
 * persisted alongside the positions state file.
 */

import fs from "fs";
import { config } from "./config.js";
import type { LagPosition } from "./inventory.js";

interface TunableParams {
  minYieldPct: number;
  minAskPrice: number;
  maxAskPrice: number;
  monitorIntervalMs: number;
}

export interface CategoryStats {
  wins: number;
  losses: number;
  count: number;
  totalResolutionMs: number;
}

export interface LearningRecord {
  params: TunableParams;
  categoryScores: Record<string, CategoryStats>;
  categoryBlocklist: string[];
  sampleSize: number;
  lastLearnAt: string;
  notes: string[];
}

let overrides: Partial<TunableParams> = {};
let categoryBlocklist = new Set<string>();
let currentRecord: LearningRecord | null = null;

const LEARNED_FILE = process.env["POSITIONS_STATE_FILE"]
  ? `${process.env["POSITIONS_STATE_FILE"]}.learned.json`
  : "";

// ── Config merge ──────────────────────────────────────────────────────────────

export function getActiveConfig(): typeof config & TunableParams {
  return { ...config, ...overrides } as typeof config & TunableParams;
}

// ── Category inference ────────────────────────────────────────────────────────

function inferCategory(question: string): string {
  const q = question.toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana|sol|crypto|bnb|xrp|doge|usdc|defi/.test(q)) return "crypto";
  if (/election|president|senate|congress|vote|trump|biden|harris|governor|parliament|poll|ballot/.test(q)) return "politics";
  if (/nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|fifa|ufc|boxing|champion|world cup|olympics/.test(q)) return "sports";
  if (/fed|interest rate|cpi|gdp|inflation|recession|unemployment|fomc|treasury/.test(q)) return "economics";
  if (/weather|temperature|hurricane|tornado|earthquake|storm/.test(q)) return "weather";
  return "other";
}

export function isCategoryAllowed(question: string): boolean {
  return !categoryBlocklist.has(inferCategory(question));
}

// ── Core learning ─────────────────────────────────────────────────────────────

export function runLearning(positions: LagPosition[]): void {
  const MIN_SAMPLES = 2;
  const resolved = positions.filter(
    (p) => p.status === "resolved" && p.realizedPnl !== undefined,
  );

  if (resolved.length < MIN_SAMPLES) {
    console.log(
      `[learn] Not enough resolved positions (${resolved.length}/${MIN_SAMPLES}) — skipping`,
    );
    return;
  }

  const notes: string[] = [];
  const newOverrides: Partial<TunableParams> = { ...overrides };

  // ── Win / loss rate ──────────────────────────────────────────────────────────
  const wins = resolved.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const losses = resolved.filter((p) => (p.realizedPnl ?? 0) <= 0).length;
  const winRate = wins / resolved.length;
  const currentMinYield = overrides.minYieldPct ?? config.minYieldPct;

  if (losses > 0) {
    const newVal = Math.min(
      3.0,
      Math.round(Math.max(currentMinYield, 1.0) * 10) / 10,
    );
    if (newVal !== currentMinYield) {
      notes.push(
        `raised minYieldPct ${currentMinYield}→${newVal} (${losses} loss(es) detected)`,
      );
      newOverrides.minYieldPct = newVal;
    }
  } else if (resolved.length >= 10 && winRate === 1.0) {
    const floor = 0.2;
    const newVal = Math.round(Math.max(floor, currentMinYield - 0.1) * 10) / 10;
    if (newVal < currentMinYield) {
      notes.push(
        `lowered minYieldPct ${currentMinYield}→${newVal} (${resolved.length}/${resolved.length} wins)`,
      );
      newOverrides.minYieldPct = newVal;
    }
  }

  // ── Resolution speed ─────────────────────────────────────────────────────────
  const resolvedWithTime = resolved.filter((p) => p.resolvedAt && p.openedAt);
  if (resolvedWithTime.length >= 3) {
    const avgMs =
      resolvedWithTime.reduce((sum, p) => {
        return (
          sum +
          (new Date(p.resolvedAt!).getTime() - new Date(p.openedAt).getTime())
        );
      }, 0) / resolvedWithTime.length;

    const currentInterval =
      overrides.monitorIntervalMs ?? config.monitorIntervalMs;

    if (avgMs < 60 * 60 * 1000 && currentInterval > 45_000) {
      const newVal = Math.max(30_000, currentInterval - 15_000);
      notes.push(
        `lowered monitorIntervalMs ${currentInterval}→${newVal} (avg resolution ${Math.round(avgMs / 60000)}min)`,
      );
      newOverrides.monitorIntervalMs = newVal;
    } else if (avgMs > 6 * 60 * 60 * 1000 && currentInterval < 300_000) {
      const newVal = Math.min(300_000, currentInterval + 15_000);
      notes.push(
        `raised monitorIntervalMs ${currentInterval}→${newVal} (avg resolution ${Math.round(avgMs / 3_600_000)}h)`,
      );
      newOverrides.monitorIntervalMs = newVal;
    }
  }

  // ── Category scoring ─────────────────────────────────────────────────────────
  const catStats: Record<string, CategoryStats> = {};
  for (const pos of resolved) {
    const cat = inferCategory(pos.marketQuestion);
    if (!catStats[cat])
      catStats[cat] = { wins: 0, losses: 0, totalResolutionMs: 0, count: 0 };
    catStats[cat].count++;
    if ((pos.realizedPnl ?? 0) > 0) {
      catStats[cat].wins++;
    } else {
      catStats[cat].losses++;
    }
    if (pos.resolvedAt) {
      catStats[cat].totalResolutionMs +=
        new Date(pos.resolvedAt).getTime() - new Date(pos.openedAt).getTime();
    }
  }

  const newBlocklist = new Set<string>();
  for (const [cat, stats] of Object.entries(catStats)) {
    if (stats.count >= 3) {
      const catWinRate = stats.wins / stats.count;
      if (catWinRate < 0.8) {
        newBlocklist.add(cat);
        if (!categoryBlocklist.has(cat)) {
          notes.push(
            `blocked category "${cat}" (win rate ${Math.round(catWinRate * 100)}% across ${stats.count} trades)`,
          );
        }
      } else if (categoryBlocklist.has(cat)) {
        notes.push(
          `unblocked category "${cat}" (win rate recovered to ${Math.round(catWinRate * 100)}%)`,
        );
      }
    }
  }
  categoryBlocklist = newBlocklist;

  overrides = newOverrides;

  const record: LearningRecord = {
    params: {
      minYieldPct: overrides.minYieldPct ?? config.minYieldPct,
      minAskPrice: overrides.minAskPrice ?? config.minAskPrice,
      maxAskPrice: overrides.maxAskPrice ?? config.maxAskPrice,
      monitorIntervalMs: overrides.monitorIntervalMs ?? config.monitorIntervalMs,
    },
    categoryScores: catStats,
    categoryBlocklist: Array.from(categoryBlocklist),
    sampleSize: resolved.length,
    lastLearnAt: new Date().toISOString(),
    notes,
  };
  currentRecord = record;

  if (notes.length > 0) {
    console.log(`[learn] Updated parameters (${resolved.length} trades):`);
    for (const note of notes) console.log(`[learn]  • ${note}`);
  } else {
    console.log(
      `[learn] Analysis complete (${resolved.length} trades) — no changes needed`,
    );
  }

  saveRecord(record);
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveRecord(record: LearningRecord): void {
  if (!LEARNED_FILE) return;
  try {
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(record, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
}

export function loadLearned(): void {
  if (!LEARNED_FILE || !fs.existsSync(LEARNED_FILE)) return;
  try {
    const record = JSON.parse(
      fs.readFileSync(LEARNED_FILE, "utf-8"),
    ) as LearningRecord;
    currentRecord = record;

    const base = config as unknown as TunableParams;
    const restored: Partial<TunableParams> = {};
    if (record.params.minYieldPct !== base.minYieldPct)
      restored.minYieldPct = record.params.minYieldPct;
    if (record.params.minAskPrice !== base.minAskPrice)
      restored.minAskPrice = record.params.minAskPrice;
    if (record.params.maxAskPrice !== base.maxAskPrice)
      restored.maxAskPrice = record.params.maxAskPrice;
    if (record.params.monitorIntervalMs !== base.monitorIntervalMs)
      restored.monitorIntervalMs = record.params.monitorIntervalMs;
    overrides = restored;

    categoryBlocklist = new Set(record.categoryBlocklist ?? []);

    console.log(
      `[learn] Restored learned params (${record.sampleSize} trades, last: ${record.lastLearnAt})`,
    );
    if (record.notes?.length) {
      for (const n of record.notes.slice(-3)) console.log(`[learn]  • ${n}`);
    }
  } catch {
    /* non-fatal — start fresh */
  }
}

export function getLearningRecord(): LearningRecord | null {
  return currentRecord;
}
