/**
 * routes/positions.ts
 *
 * Proxy to Polymarket data-api to avoid browser CORS issues.
 *
 * GET  /positions?depositWallet=<address>         — all positions for a wallet
 * GET  /positions/summary?depositWallet=<address> — summary stats
 * POST /positions/attribute                        — bots call this to record which bot opened a position
 * GET  /positions/by-user?address=<metamask>       — CLOB positions merged with bot attribution
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router, Request, Response } from "express";
import { getAllUsers } from "../user-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data");
const POSITIONS_DIR = path.join(DATA_DIR, "positions");

const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

// Simple in-memory cache: key → { data, fetchedAt }
const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

// ── Attribution storage ───────────────────────────────────────────────────────

export interface AttributionEntry {
  conditionId: string;   // bytes32 hex; may be "" when not available (e.g. microstructure)
  outcomeIndex: number;  // 0 = YES/home, 1 = NO/away
  tokenId: string;       // ERC-1155 token decimal string — always available
  botName: string;
  marketQuestion: string;
  side: string;          // "YES", "NO", etc.
  openedAt: string;      // ISO timestamp
}

function attributionFile(slot: number): string {
  return path.join(POSITIONS_DIR, `attribution-u${slot}.json`);
}

export function readAttribution(slot: number): AttributionEntry[] {
  try {
    const file = attributionFile(slot);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8")) as AttributionEntry[];
  } catch {
    return [];
  }
}

function writeAttribution(slot: number, entries: AttributionEntry[]): void {
  try {
    if (!fs.existsSync(POSITIONS_DIR))
      fs.mkdirSync(POSITIONS_DIR, { recursive: true });
    fs.writeFileSync(attributionFile(slot), JSON.stringify(entries, null, 2));
  } catch {}
}

function addAttribution(slot: number, entry: AttributionEntry): void {
  const existing = readAttribution(slot);
  // Deduplicate by tokenId — keep the latest entry for each tokenId
  const filtered = existing.filter((e) => e.tokenId !== entry.tokenId);
  filtered.push(entry);
  // Keep last 500 entries to prevent unbounded growth
  writeAttribution(slot, filtered.slice(-500));
}

/** Build a lookup map: tokenId → botName from the attribution file for a slot. */
export function buildAttributionMap(slot: number): Map<string, string> {
  const entries = readAttribution(slot);
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(e.tokenId, e.botName);
    // Also index by conditionId when available so we match both YES and NO
    if (e.conditionId) map.set(e.conditionId, e.botName);
  }
  return map;
}

/** Resolve user slot from MetaMask address. */
function slotForUser(address: string): number | null {
  const users = getAllUsers();
  const user = users.find(
    (u) => u.metamask_address.toLowerCase() === address.toLowerCase(),
  );
  if (!user) return null;
  return user.bot_wallet_index - 10;
}

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

// POST /positions/attribute
// Body: { userAddress, conditionId?, outcomeIndex?, tokenId, botName, marketQuestion, side }
// Called by bots (fire-and-forget) after placing an order.
positionsRouter.post("/attribute", (req: Request, res: Response) => {
  const {
    userAddress,
    conditionId = "",
    outcomeIndex = 0,
    tokenId,
    botName,
    marketQuestion = "",
    side = "",
  } = req.body as {
    userAddress?: string;
    conditionId?: string;
    outcomeIndex?: number;
    tokenId?: string;
    botName?: string;
    marketQuestion?: string;
    side?: string;
  };

  if (!userAddress || !tokenId || !botName) {
    res.status(400).json({ error: "userAddress, tokenId, botName required" });
    return;
  }

  const slot = slotForUser(userAddress);
  if (slot === null) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  addAttribution(slot, {
    conditionId,
    outcomeIndex,
    tokenId,
    botName,
    marketQuestion,
    side,
    openedAt: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// GET /positions/by-user?address=<metamaskAddress>[&depositWallet=<addr>]
// Returns CLOB positions for the user's deposit wallet, merged with bot attribution.
positionsRouter.get("/by-user", async (req: Request, res: Response) => {
  const address = req.query["address"] as string | undefined;
  const depositWalletOverride = req.query["depositWallet"] as
    | string
    | undefined;

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "address must be a valid 0x address" });
    return;
  }

  const slot = slotForUser(address);
  if (slot === null) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const users = getAllUsers();
  const user = users.find(
    (u) => u.metamask_address.toLowerCase() === address.toLowerCase(),
  );
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Resolve deposit wallet: prefer override, else read attribution file for stored address,
  // else fall back to ecosystemJSON env var lookup.
  let depositWallet = depositWalletOverride ?? "";
  if (!depositWallet) {
    // Try to read from the bot ecosystem JSON for this slot
    try {
      const ecoPath = path.join(
        DATA_DIR,
        `envs/ecosystem-u${slot}.json`,
      );
      if (fs.existsSync(ecoPath)) {
        const eco = JSON.parse(fs.readFileSync(ecoPath, "utf8")) as {
          apps?: Array<{ env?: { POLYMARKET_WALLET_ADDRESS?: string } }>;
        };
        depositWallet =
          eco.apps?.[0]?.env?.POLYMARKET_WALLET_ADDRESS ?? "";
      }
    } catch {}
  }

  if (!depositWallet || !/^0x[0-9a-fA-F]{40}$/.test(depositWallet)) {
    res.status(400).json({
      error: "Could not determine deposit wallet for this user",
    });
    return;
  }

  try {
    const positions = await fetchPositions(depositWallet);
    const attrMap = buildAttributionMap(slot);

    const enriched = positions.map((p) => {
      // Try to attribute by tokenId (asset) first, then by conditionId
      const botName =
        attrMap.get(p.asset) ?? attrMap.get(p.conditionId) ?? null;
      return { ...p, sourceWallet: depositWallet, botName };
    });

    res.json({ positions: enriched, slot, depositWallet });
  } catch (err) {
    console.error("positions/by-user error", err);
    res.status(502).json({ error: "Failed to fetch positions from Polymarket" });
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
