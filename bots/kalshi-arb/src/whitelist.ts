import fs from "fs";
import path from "path";

const STATE_FILE =
  process.env["WHITELIST_STATE_FILE"] ??
  path.join(process.cwd(), "data", "kalshi-arb-whitelist.json");

let _whitelist = new Set<string>();

export function loadWhitelist(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as string[];
      _whitelist = new Set(Array.isArray(raw) ? raw : []);
    }
  } catch {
    _whitelist = new Set();
  }
}

function save(): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify([..._whitelist], null, 2));
  } catch (err) {
    console.error("[whitelist] save error:", (err as Error).message);
  }
}

export function isWhitelisted(ticker: string): boolean {
  return _whitelist.has(ticker);
}

export function addToWhitelist(ticker: string): void {
  _whitelist.add(ticker);
  save();
}

export function removeFromWhitelist(ticker: string): void {
  _whitelist.delete(ticker);
  save();
}

export function getWhitelist(): string[] {
  return [..._whitelist];
}
