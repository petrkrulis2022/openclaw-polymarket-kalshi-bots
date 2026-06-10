import fs from "fs";
import path from "path";

export interface KalshiPolyPair {
  id: string;
  kalshiTicker: string;
  polyConditionId: string;
  polyYesTokenId: string;
  polyNoTokenId: string;
  kalshiOrderId: string;
  polyOrderId: string;
  kalshiSide: "yes" | "no";
  polySide: "yes" | "no";
  kalshiEntryVwap: number;
  polyEntryVwap: number;
  entryEdgePct: number;
  sizeUsd: number;
  status: "pending" | "filled" | "closed" | "cancelled";
  openedAt: string;
  closedAt?: string;
  realizedPnl?: number;
}

const STATE_FILE =
  process.env["POSITIONS_STATE_FILE"] ??
  path.join(process.cwd(), "data", "kalshi-arb-pairs.json");

let _pairs: KalshiPolyPair[] = [];

export function loadInventory(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      _pairs = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as KalshiPolyPair[];
    }
  } catch {
    _pairs = [];
  }
}

function save(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(_pairs, null, 2));
}

export function getOpenPairs(): KalshiPolyPair[] {
  return _pairs.filter((p) => p.status === "pending" || p.status === "filled");
}

export function getAllPairs(): KalshiPolyPair[] {
  return [..._pairs];
}

export function addPair(pair: KalshiPolyPair): void {
  _pairs.push(pair);
  save();
}

export function updatePair(id: string, updates: Partial<KalshiPolyPair>): void {
  const idx = _pairs.findIndex((p) => p.id === id);
  if (idx !== -1) {
    _pairs[idx] = { ..._pairs[idx], ...updates };
    save();
  }
}
