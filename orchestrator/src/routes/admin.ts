/**
 * routes/admin.ts
 *
 * Admin-only API for viewing all registered users and their live balances.
 * Protected by a Bearer password set in the ADMIN_PASSWORD environment variable.
 *
 * GET  /admin/users   — Returns all users enriched with live on-chain balances.
 */

import { Router, Request, Response, NextFunction } from "express";
import { spawn } from "child_process";
import { getAllUsers, setBotsRunning } from "../user-store.js";

/** Run a shell command and return stdout. */
function runCmd(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
  });
}

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

      // Fetch live balances + PM2 status for all users in parallel
      let pm2List: Array<{ name: string; pm2_env?: { status?: string } }> = [];
      try {
        const raw = await runCmd("pm2", ["jlist"]);
        pm2List = JSON.parse(raw) as typeof pm2List;
      } catch {
        // PM2 not available — leave pm2List empty
      }

      const enriched = await Promise.all(
        users.map(async (user) => {
          // Derive user slot and PM2 process names (same formula as users.ts)
          const slot = user.bot_wallet_index - 10;
          const botNames = [
            "market-maker",
            "copy-trader",
            "in-market-arb",
            "resolution-lag",
            "microstructure",
          ];
          const anyOnline = botNames.some((name) => {
            const pmName = `${name}-u${slot}`;
            const proc = pm2List.find((p) => p.name === pmName);
            return proc?.pm2_env?.status === "online";
          });

          // Auto-correct the DB flag if stale
          let botsRunning = user.bots_running === 1;
          if (anyOnline && !botsRunning) {
            setBotsRunning(user.metamask_address, true);
            botsRunning = true;
          } else if (!anyOnline && botsRunning) {
            setBotsRunning(user.metamask_address, false);
            botsRunning = false;
          }

          const safeUser = {
            metamask_address: user.metamask_address,
            bot_wallet_address: user.bot_wallet_address,
            bot_wallet_index: user.bot_wallet_index,
            has_api_keys: !!user.poly_funder_address,
            bots_running: botsRunning,
            autonomous_mode: user.autonomous_mode === 1,
            created_at: user.created_at,
            // Balance fields — populated below if wallet is derived
            usdt: null as string | null,
            usdce: null as string | null,
            native_pol: null as string | null,
            deposit_wallet_address: null as string | null,
            deposit_wallet_pusd: null as string | null,
            deposit_wallet_usdce: null as string | null,
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
                depositWalletAddress?: string;
                depositWalletPusd?: string;
                depositWalletUsdce?: string;
              };
              safeUser.usdt = bal.usdt;
              safeUser.usdce = bal.usdce;
              safeUser.native_pol = bal.nativePol;
              safeUser.deposit_wallet_address =
                bal.depositWalletAddress ?? null;
              safeUser.deposit_wallet_pusd = bal.depositWalletPusd ?? null;
              safeUser.deposit_wallet_usdce = bal.depositWalletUsdce ?? null;
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

// ── POST /admin/users/:address/set-bots-running ───────────────────────────────
// Admin override: manually force the bots_running flag in DB.
// Useful when bots were started/stopped outside the REST API.

router.post(
  "/users/:address/set-bots-running",
  requireAdminPassword,
  (req: Request, res: Response) => {
    const { address } = req.params;
    const { running } = req.body as { running?: boolean };
    if (typeof running !== "boolean") {
      return res.status(400).json({ error: "running (boolean) is required" });
    }
    setBotsRunning(address, running);
    return res.json({ ok: true, address, botsRunning: running });
  },
);

export default router;
