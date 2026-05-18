/**
 * routes/positions.ts
 *
 * Proxy to Polymarket data-api to avoid browser CORS issues.
 *
 * GET /positions?depositWallet=<address>
 *   Returns the full position list for the given deposit wallet.
 *
 * GET /positions/summary?depositWallet=<address>
 *   Returns { totalSharesValue, redeemableCount, redeemableValue }
 */

import { Router, Request, Response } from "express";

const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

// Simple in-memory cache: key → { data, fetchedAt }
const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

interface PolyPosition {
  proxyWallet: string;
  asset: string; // tokenId (decimal string)
  conditionId: string; // bytes32 hex
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

async function fetchPositions(depositWallet: string): Promise<PolyPosition[]> {
  const cacheKey = depositWallet.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data as PolyPosition[];
  }

  const url = `${POLYMARKET_DATA_API}/positions?user=${encodeURIComponent(depositWallet)}&sizeThreshold=0&limit=100`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Polymarket data-api error: HTTP ${res.status}`);
  }
  const data = (await res.json()) as PolyPosition[];
  cache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

export const positionsRouter = Router();

// GET /positions?depositWallet=<address>[&botWallet=<address>]
positionsRouter.get("/", async (req: Request, res: Response) => {
  const depositWallet = req.query["depositWallet"] as string | undefined;
  const botWallet = req.query["botWallet"] as string | undefined;

  if (!depositWallet || !/^0x[0-9a-fA-F]{40}$/.test(depositWallet)) {
    res.status(400).json({ error: "depositWallet must be a valid 0x address" });
    return;
  }
  if (botWallet && !/^0x[0-9a-fA-F]{40}$/.test(botWallet)) {
    res.status(400).json({ error: "botWallet must be a valid 0x address" });
    return;
  }

  try {
    const promises: Promise<PolyPosition[]>[] = [fetchPositions(depositWallet)];
    // Fetch the bot's own trading wallet positions when it differs from the deposit wallet.
    if (botWallet && botWallet.toLowerCase() !== depositWallet.toLowerCase()) {
      promises.push(fetchPositions(botWallet));
    }
    const [depositPositions, botPositions = []] = await Promise.all(promises);

    // Merge, tagging each position with its source wallet. Deduplicate by
    // (conditionId + outcomeIndex) — prefer the deposit wallet if duplicated.
    const seen = new Set<string>();
    const merged: (PolyPosition & { sourceWallet: string })[] = [];
    for (const p of depositPositions) {
      const key = `${p.conditionId}:${p.outcomeIndex}`;
      seen.add(key);
      merged.push({ ...p, sourceWallet: depositWallet });
    }
    for (const p of botPositions) {
      const key = `${p.conditionId}:${p.outcomeIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ ...p, sourceWallet: botWallet! });
      }
    }

    res.json({ positions: merged });
  } catch (err) {
    console.error("positions fetch error", err);
    res
      .status(502)
      .json({ error: "Failed to fetch positions from Polymarket" });
  }
});

// GET /positions/summary?depositWallet=<address>[&botWallet=<address>]
positionsRouter.get("/summary", async (req: Request, res: Response) => {
  const depositWallet = req.query["depositWallet"] as string | undefined;
  const botWallet = req.query["botWallet"] as string | undefined;

  if (!depositWallet || !/^0x[0-9a-fA-F]{40}$/.test(depositWallet)) {
    res.status(400).json({ error: "depositWallet must be a valid 0x address" });
    return;
  }

  try {
    const promises: Promise<PolyPosition[]>[] = [fetchPositions(depositWallet)];
    if (botWallet && botWallet.toLowerCase() !== depositWallet.toLowerCase()) {
      promises.push(fetchPositions(botWallet));
    }
    const allPositions = (await Promise.all(promises)).flat();

    // Deduplicate by (conditionId + outcomeIndex)
    const seen = new Set<string>();
    const positions = allPositions.filter((p) => {
      const key = `${p.conditionId}:${p.outcomeIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const totalSharesValue = positions.reduce(
      (sum, p) => sum + (p.currentValue ?? 0),
      0,
    );
    const redeemable = positions.filter((p) => p.redeemable);
    const redeemableCount = redeemable.length;
    const redeemableValue = redeemable.reduce(
      (sum, p) => sum + (p.currentValue ?? 0),
      0,
    );
    res.json({ totalSharesValue, redeemableCount, redeemableValue });
  } catch (err) {
    console.error("positions/summary error", err);
    res
      .status(502)
      .json({ error: "Failed to fetch positions from Polymarket" });
  }
});
