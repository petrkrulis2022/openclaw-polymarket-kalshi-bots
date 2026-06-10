/**
 * routes/fills.ts — per-order fill log (append-only JSONL)
 *
 * POST /fills       — bots call this after each confirmed fill
 * GET  /fills       — read recent fills, optional ?limit=N&botId=X filter
 *
 * File: orchestrator/data/fills.jsonl
 * Each line is one JSON record:
 *   { ts, botId, side, tokenId, signalPrice, fillPrice, fillShares, fillUsdc, fillStatus, meta }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router, Request, Response } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const FILLS_FILE = path.join(DATA_DIR, "fills.jsonl");

export interface FillRecord {
  ts: string;
  botId: string;
  side: "BUY" | "SELL";
  tokenId: string;
  signalPrice: number;
  fillPrice: number;
  fillShares: number;
  fillUsdc: number;
  fillStatus: "filled" | "partial" | "zero";
  meta?: Record<string, unknown>;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const fillsRouter = Router();

fillsRouter.post("/", (req: Request, res: Response) => {
  const body = req.body as Partial<FillRecord>;
  if (!body.botId || !body.ts) {
    res.status(400).json({ error: "botId and ts are required" });
    return;
  }
  const record: FillRecord = {
    ts: body.ts,
    botId: body.botId,
    side: body.side ?? "BUY",
    tokenId: body.tokenId ?? "",
    signalPrice: body.signalPrice ?? 0,
    fillPrice: body.fillPrice ?? 0,
    fillShares: body.fillShares ?? 0,
    fillUsdc: body.fillUsdc ?? 0,
    fillStatus: body.fillStatus ?? "filled",
    meta: body.meta,
  };
  try {
    ensureDataDir();
    fs.appendFileSync(FILLS_FILE, JSON.stringify(record) + "\n");
    res.json({ ok: true });
  } catch (err) {
    console.error("[fills] write error:", (err as Error).message);
    res.status(500).json({ error: "write failed" });
  }
});

fillsRouter.get("/", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "200"), 10), 1000);
  const botIdFilter = req.query["botId"] ? String(req.query["botId"]) : null;

  try {
    if (!fs.existsSync(FILLS_FILE)) {
      res.json({ fills: [] });
      return;
    }
    const raw = fs.readFileSync(FILLS_FILE, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const records: FillRecord[] = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as FillRecord;
        if (!botIdFilter || r.botId === botIdFilter) records.push(r);
      } catch {
        // skip malformed lines
      }
    }
    // return last N (most recent)
    res.json({ fills: records.slice(-limit) });
  } catch (err) {
    console.error("[fills] read error:", (err as Error).message);
    res.status(500).json({ error: "read failed" });
  }
});
