/**
 * pending.ts — in-memory approval queue for copy-trade signals.
 *
 * Flow:
 *   signal detected → addPending() → status "pending"
 *   manual mode:   dashboard calls approve(id) → status "approved" → executor runs
 *   auto mode:     addPending() immediately returns "approved" → executor runs
 *   orchestrator:  POST to orchestrator for AI decision, updates on callback
 *   expiry:        expireOld() sets stale entries to "expired"
 */

import type { CopySignal } from "./tracker.js";

export type TradeStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "expired"
  | "failed";

export interface PendingTrade extends CopySignal {
  status: TradeStatus;
  expiresAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  executionPrice: number | null;
  executedSize: number | null;
  executedOrderId: string | null;
  errorMessage: string | null;
}

// Ordered map (insertion order preserved)
const queue = new Map<string, PendingTrade>();

export function addPending(
  signal: CopySignal,
  expiryMs: number,
  initialStatus: TradeStatus = "pending",
): PendingTrade {
  const trade: PendingTrade = {
    ...signal,
    status: initialStatus,
    expiresAt: new Date(Date.now() + expiryMs).toISOString(),
    approvedAt: initialStatus === "approved" ? new Date().toISOString() : null,
    rejectedAt: null,
    executedAt: null,
    executionPrice: null,
    executedSize: null,
    executedOrderId: null,
    errorMessage: null,
  };
  queue.set(signal.id, trade);
  return trade;
}

export function approve(id: string): PendingTrade | null {
  const t = queue.get(id);
  if (!t || t.status !== "pending") return null;
  t.status = "approved";
  t.approvedAt = new Date().toISOString();
  return t;
}

export function reject(id: string): boolean {
  const t = queue.get(id);
  if (!t || t.status !== "pending") return false;
  t.status = "rejected";
  t.rejectedAt = new Date().toISOString();
  return true;
}

export function markExecuted(
  id: string,
  orderId: string,
  price: number,
  size: number,
): void {
  const t = queue.get(id);
  if (!t) return;
  t.status = "executed";
  t.executedAt = new Date().toISOString();
  t.executedOrderId = orderId;
  t.executionPrice = price;
  t.executedSize = size;
}

export function markFailed(id: string, errorMessage: string): void {
  const t = queue.get(id);
  if (!t) return;
  t.status = "failed";
  t.errorMessage = errorMessage;
}

export function expireOld(): void {
  const now = Date.now();
  for (const t of queue.values()) {
    if (t.status === "pending" && new Date(t.expiresAt).getTime() < now) {
      t.status = "expired";
    }
  }
}

export function getPending(id: string): PendingTrade | undefined {
  return queue.get(id);
}

/** All entries (most recent first) */
export function listAll(): PendingTrade[] {
  return Array.from(queue.values()).reverse();
}

/** Only entries waiting for approval */
export function listPending(): PendingTrade[] {
  return Array.from(queue.values()).filter((t) => t.status === "pending");
}

/** Only entries approved and ready for execution */
export function listApproved(): PendingTrade[] {
  return Array.from(queue.values()).filter((t) => t.status === "approved");
}

/**
 * Keep at most `limit` terminal entries (executed/rejected/expired/failed)
 * to bound memory usage.
 */
export function pruneTerminal(limit = 200): void {
  const terminal: string[] = [];
  for (const [id, t] of queue) {
    if (["executed", "rejected", "expired", "failed"].includes(t.status)) {
      terminal.push(id);
    }
  }
  // Delete oldest beyond limit
  const toDelete = terminal.slice(0, Math.max(0, terminal.length - limit));
  for (const id of toDelete) queue.delete(id);
}
