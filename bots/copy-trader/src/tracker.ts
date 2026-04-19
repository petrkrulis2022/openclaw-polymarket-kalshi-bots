/**
 * tracker.ts — polls Polymarket Data API for trader position changes
 * and emits CopySignal objects when positions open / increase / decrease / close.
 */

import { config } from "./config.js";
import { params } from "./runtime-config.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CopySignal {
  /** Unique signal ID (uuid-like, timestamp + random) */
  id: string;
  traderAddress: string;
  traderLabel: string;
  /** Polymarket token ID (YES or NO side of a market) */
  tokenId: string;
  /** Human-readable market title */
  marketTitle: string;
  /** "Yes" | "No" (raw from Data API) */
  outcome: string;
  /** BUY = trader increased position, SELL = trader decreased/closed */
  side: "BUY" | "SELL";
  /** Change in shares detected for the trader */
  traderDeltaShares: number;
  /** Approximate USD value of the delta (deltaShares × curPrice) */
  traderDeltaUsd: number;
  /** Pre-calculated number of shares we should trade */
  ourTargetShares: number;
  /** Approximate USD cost for our trade */
  ourTargetUsd: number;
  /** Current best price at time of signal */
  suggestedPrice: number;
  detectedAt: string;
}

// ── Internal snapshot types ──────────────────────────────────────────────────

interface DataApiPosition {
  market: string; // condition ID
  asset: string; // token ID
  size: string; // current share count
  avgPrice: string;
  currentValue: string;
  curPrice: string;
  title: string;
  outcome: string; // "Yes" | "No"
  outcomeIndex: number;
}

type PositionSnapshot = Map<string, DataApiPosition>; // keyed by asset (tokenId)

// Per-trader snapshot store
const snapshots = new Map<string, PositionSnapshot>();

// ── ID generator ─────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Data API fetch ────────────────────────────────────────────────────────────

async function fetchPositions(address: string): Promise<DataApiPosition[]> {
  const url = `${config.polymarket.dataApiHost}/positions?user=${encodeURIComponent(address)}&limit=500&sizeThreshold=.1`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Data API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as DataApiPosition[];
  return Array.isArray(data) ? data : [];
}

// ── Snapshot diffing ──────────────────────────────────────────────────────────

function diffSnapshots(
  prev: PositionSnapshot,
  curr: DataApiPosition[],
  traderAddress: string,
  traderLabel: string,
  allocationUsd: number,
  copyRatio: number,
): CopySignal[] {
  const signals: CopySignal[] = [];
  const minSignalUsd = params.minSignalUsd;

  const currMap: PositionSnapshot = new Map(curr.map((p) => [p.asset, p]));

  // Check current positions vs previous
  for (const [tokenId, currPos] of currMap) {
    const prevPos = prev.get(tokenId);
    const currSize = parseFloat(currPos.size);
    const prevSize = prevPos ? parseFloat(prevPos.size) : 0;
    const delta = currSize - prevSize;
    const curPrice = parseFloat(currPos.curPrice) || 0.01;
    const deltaUsd = Math.abs(delta) * curPrice;

    if (Math.abs(delta) < 0.01 || deltaUsd < minSignalUsd) continue;

    const side: "BUY" | "SELL" = delta > 0 ? "BUY" : "SELL";

    // Scale our trade: (traderDeltaUsd / traderTotalAlloc) capped at 1.0 × ourAllocation × copyRatio
    // Simpler: ourShares = abs(delta) * copyRatio, capped by (allocationUsd / curPrice)
    const maxShares = allocationUsd / curPrice;
    const ourShares = Math.min(Math.abs(delta) * copyRatio, maxShares);
    const ourUsd = ourShares * curPrice;

    if (ourUsd < minSignalUsd) continue;

    signals.push({
      id: makeId(),
      traderAddress,
      traderLabel,
      tokenId,
      marketTitle: currPos.title,
      outcome: currPos.outcome,
      side,
      traderDeltaShares: delta,
      traderDeltaUsd: deltaUsd,
      ourTargetShares: ourShares,
      ourTargetUsd: ourUsd,
      suggestedPrice: curPrice,
      detectedAt: new Date().toISOString(),
    });
  }

  // Detect full closes (position disappeared from snapshot)
  for (const [tokenId, prevPos] of prev) {
    if (!currMap.has(tokenId)) {
      const prevSize = parseFloat(prevPos.size);
      const curPrice = parseFloat(prevPos.curPrice) || 0.01;
      const deltaUsd = prevSize * curPrice;

      if (deltaUsd < minSignalUsd) continue;

      // Full close — SELL everything proportionally
      const maxShares = allocationUsd / curPrice;
      const ourShares = Math.min(prevSize * copyRatio, maxShares);
      const ourUsd = ourShares * curPrice;

      if (ourUsd < minSignalUsd) continue;

      signals.push({
        id: makeId(),
        traderAddress,
        traderLabel,
        tokenId,
        marketTitle: prevPos.title,
        outcome: prevPos.outcome,
        side: "SELL",
        traderDeltaShares: -prevSize,
        traderDeltaUsd: deltaUsd,
        ourTargetShares: ourShares,
        ourTargetUsd: ourUsd,
        suggestedPrice: curPrice,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return signals;
}

// ── Public polling function ───────────────────────────────────────────────────

/**
 * Poll a single trader, compute diffs against the last snapshot,
 * and return any new CopySignals.
 */
export async function pollTrader(
  address: string,
  label: string,
  allocationUsd: number,
  copyRatio: number,
): Promise<CopySignal[]> {
  let positions: DataApiPosition[];
  try {
    positions = await fetchPositions(address);
  } catch (err) {
    console.warn(
      `[tracker] Failed to fetch positions for ${label} (${address}):`,
      (err as Error).message,
    );
    return [];
  }

  const prev = snapshots.get(address) ?? new Map();
  const signals = diffSnapshots(
    prev,
    positions,
    address,
    label,
    allocationUsd,
    copyRatio,
  );

  // Update snapshot
  const newSnapshot: PositionSnapshot = new Map(
    positions.map((p) => [p.asset, p]),
  );
  snapshots.set(address, newSnapshot);

  return signals;
}

/**
 * Get the current position snapshot for a trader (for display / debugging).
 */
export function getSnapshot(address: string): DataApiPosition[] {
  const snap = snapshots.get(address);
  if (!snap) return [];
  return Array.from(snap.values());
}

/**
 * Remove a trader's snapshot when they are removed from tracking.
 */
export function removeSnapshot(address: string): void {
  snapshots.delete(address);
}
