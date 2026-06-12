/**
 * activity.ts — in-memory ring buffer of recent bot decisions/events.
 * Per-bot copy (same pattern as inventory.ts). Served via GET /activity.
 */

export type ActivityLevel = "info" | "warn" | "error";

export interface ActivityEntry {
  /** Monotonic sequence number — stable React keys, incremental fetch. */
  seq: number;
  ts: string;
  event: string;
  level: ActivityLevel;
  detail?: Record<string, unknown>;
}

const MAX_ENTRIES = 200;
const buf: ActivityEntry[] = [];
let seqCounter = 0;

export function logActivity(
  event: string,
  detail?: Record<string, unknown>,
  level: ActivityLevel = "info",
): void {
  const entry: ActivityEntry = {
    seq: ++seqCounter,
    ts: new Date().toISOString(),
    event,
    level,
  };
  if (detail) entry.detail = detail;
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
}

export function getActivity(limit = 100, afterSeq = 0): ActivityEntry[] {
  const src = afterSeq > 0 ? buf.filter((e) => e.seq > afterSeq) : buf;
  return src.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
}
