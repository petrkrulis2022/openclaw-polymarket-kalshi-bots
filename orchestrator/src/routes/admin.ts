/**
 * routes/admin.ts
 *
 * Admin-only API for viewing all registered users and their live balances.
 * Protected by a Bearer password set in the ADMIN_PASSWORD environment variable.
 *
 * GET  /admin/users   — Returns all users enriched with live on-chain balances.
 */

import { Router, Request, Response, NextFunction } from "express";
import { getAllUsers } from "../user-store.js";

const router = Router();

const WDK_TREASURY_URL =
  process.env["WDK_TREASURY_URL"] ?? "http://localhost:3001";

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdminPassword(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPassword) {
    res
      .status(503)
      .json({ error: "ADMIN_PASSWORD is not configured on the server." });
    return;
  }

  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (token !== adminPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

// ── GET /admin/users ──────────────────────────────────────────────────────────

router.get(
  "/users",
  requireAdminPassword,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = getAllUsers();

      // Fetch live balances for all users in parallel
      const enriched = await Promise.all(
        users.map(async (user) => {
          const safeUser = {
            metamask_address: user.metamask_address,
            bot_wallet_address: user.bot_wallet_address,
            bot_wallet_index: user.bot_wallet_index,
            has_api_keys: !!(user.poly_api_key && user.poly_api_secret),
            bots_running: user.bots_running === 1,
            autonomous_mode: user.autonomous_mode === 1,
            created_at: user.created_at,
            // Balance fields — populated below if wallet is derived
            usdt: null as string | null,
            usdce: null as string | null,
            native_pol: null as string | null,
          };

          if (!user.bot_wallet_address) return safeUser;

          try {
            const balRes = await fetch(`${WDK_TREASURY_URL}/balance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ index: user.bot_wallet_index }),
            });

            if (balRes.ok) {
              const bal = (await balRes.json()) as {
                usdt: string;
                usdce: string;
                nativePol: string;
              };
              safeUser.usdt = bal.usdt;
              safeUser.usdce = bal.usdce;
              safeUser.native_pol = bal.nativePol;
            }
          } catch {
            // Balance fetch failed — leave nulls
          }

          return safeUser;
        }),
      );

      return res.json(enriched);
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
