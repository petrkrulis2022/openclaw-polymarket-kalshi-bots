/**
 * routes/users.ts
 *
 * REST endpoints for multi-user registration and bot management.
 *
 * POST /users/register           — register or look up a MetaMask address
 * GET  /users/:address           — fetch user record
 * PUT  /users/:address/api-keys  — save Polymarket API credentials
 * POST /users/:address/start-bots — spawn PM2 bot processes for this user
 * POST /users/:address/stop-bots  — stop PM2 bot processes for this user
 */

import { Router, Request, Response, NextFunction } from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getUser,
  upsertUser,
  updateBotWalletAddress,
  updateApiKeys,
  updateFunderAddress,
  setBotsRunning,
  setAutonomousMode,
  type User,
} from "../user-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const DATA_DIR = path.resolve(__dirname, "../../data");
const ENVS_DIR = path.join(DATA_DIR, "envs");

const WDK_TREASURY_URL =
  process.env["WDK_TREASURY_URL"] ?? "http://localhost:3001";

// Bot definitions: name → { folder, botId, portOffset }
// portOffset 0-4 relative to user base port
const BOT_DEFS = [
  { name: "market-maker", folder: "market-maker", botId: 1, portOffset: 0 },
  { name: "copy-trader", folder: "copy-trader", botId: 3, portOffset: 1 },
  { name: "in-market-arb", folder: "in-market-arb", botId: 4, portOffset: 2 },
  {
    name: "resolution-lag",
    folder: "resolution-lag",
    botId: 5,
    portOffset: 3,
  },
  { name: "microstructure", folder: "microstructure", botId: 6, portOffset: 4 },
] as const;

/** User slot = bot_wallet_index - 10 (indices 0-9 reserved for treasury/system) */
function userSlot(botWalletIndex: number): number {
  return botWalletIndex - 10;
}

/** Base port for a user's bots.  User slot 0 → 4010, slot 1 → 4020, … */
function userBasePort(botWalletIndex: number): number {
  return 4010 + userSlot(botWalletIndex) * 10;
}

function safeUser(user: User) {
  return {
    metamaskAddress: user.metamask_address,
    botWalletAddress: user.bot_wallet_address,
    // hasApiKeys now reflects whether Polymarket funder address (proxy wallet) is configured.
    // Bots auto-derive their API creds from the private key via clob-client-v2.
    hasApiKeys: !!user.poly_funder_address,
    funderAddress: user.poly_funder_address ?? null,
    botsRunning: user.bots_running === 1,
    autonomousMode: user.autonomous_mode === 1,
    createdAt: user.created_at,
  };
}

/** Call WDK treasury to derive a bot wallet at the given HD index. */
async function deriveWallet(
  index: number,
): Promise<{ address: string; signerKey: string }> {
  const res = await fetch(`${WDK_TREASURY_URL}/derive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Treasury /derive failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<{ address: string; signerKey: string }>;
}

/** Run a shell command and return stdout (rejects on non-zero exit). */
function runCmd(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

// ── POST /users/register ─────────────────────────────────────────────────────

router.post(
  "/register",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { metamaskAddress } = req.body as { metamaskAddress?: string };
      if (!metamaskAddress || !/^0x[0-9a-fA-F]{40}$/.test(metamaskAddress)) {
        return res.status(400).json({ error: "Invalid metamaskAddress" });
      }

      // Look up or create the user record (allocates HD index)
      const user = upsertUser(metamaskAddress);

      // Derive bot wallet address if not yet stored
      if (!user.bot_wallet_address) {
        const { address } = await deriveWallet(user.bot_wallet_index);
        updateBotWalletAddress(metamaskAddress, address);
        user.bot_wallet_address = address;
      }

      return res.json(safeUser(user));
    } catch (err) {
      return next(err);
    }
  },
);

// ── GET /users/:address ───────────────────────────────────────────────────────

router.get("/:address", (req: Request, res: Response) => {
  const { address } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json(safeUser(user));
});

// ── PUT /users/:address/api-keys ──────────────────────────────────────────────
// Kept for backward-compat; stores API key/secret/passphrase if provided.

router.put("/:address/api-keys", (req: Request, res: Response) => {
  const { address } = req.params;
  const { apiKey, apiSecret, apiPassphrase } = req.body as {
    apiKey?: string;
    apiSecret?: string;
    apiPassphrase?: string;
  };

  if (!apiKey || !apiSecret || !apiPassphrase) {
    return res
      .status(400)
      .json({ error: "apiKey, apiSecret, and apiPassphrase are required" });
  }

  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  updateApiKeys(address, apiKey, apiSecret, apiPassphrase);
  return res.json({ ok: true });
});

// ── PUT /users/:address/funder-address ─────────────────────────────────────────
// Save the Polymarket proxy wallet address (funderAddress for GNOSIS_SAFE sigs).

router.put("/:address/funder-address", (req: Request, res: Response) => {
  const { address } = req.params;
  const { funderAddress } = req.body as { funderAddress?: string };

  if (!funderAddress || !/^0x[0-9a-fA-F]{40}$/.test(funderAddress)) {
    return res.status(400).json({
      error: "Invalid funderAddress (must be a 0x-prefixed EVM address)",
    });
  }

  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  updateFunderAddress(address, funderAddress);
  return res.json({ ok: true });
});

// ── POST /users/:address/start-bots ───────────────────────────────────────────

router.post(
  "/:address/start-bots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }
      if (!user.poly_funder_address) {
        return res.status(400).json({
          error:
            "Polymarket funder address not configured — complete onboarding step 2 first",
        });
      }

      // Get the signer key from treasury (needed to sign Polymarket orders)
      const { signerKey } = await deriveWallet(user.bot_wallet_index);

      // Write per-user env files and build PM2 app configs
      if (!fs.existsSync(ENVS_DIR)) fs.mkdirSync(ENVS_DIR, { recursive: true });

      const slot = userSlot(user.bot_wallet_index);
      const basePort = userBasePort(user.bot_wallet_index);
      const apps = BOT_DEFS.map((bot) => {
        const port = basePort + bot.portOffset;
        const pmName = `${bot.name}-u${slot}`;
        const botDir = path.join(REPO_ROOT, "bots", bot.folder);

        return {
          name: pmName,
          script: "npx",
          args: "tsx src/index.ts",
          cwd: botDir,
          env: {
            PORT: String(port),
            BOT_ID: String(bot.botId),
            POLYMARKET_WALLET_ADDRESS: user.poly_funder_address,
            BOT_SIGNER_KEY: signerKey,
            POLYMARKET_FUNDER_ADDRESS: user.poly_funder_address,
            POLYMARKET_SIGNATURE_TYPE: "POLY_1271",
            ORCHESTRATOR_URL: `http://localhost:${process.env["PORT"] ?? 3002}`,
            TREASURY_URL: WDK_TREASURY_URL,
            PAPER_TRADING: "",
          },
        };
      });

      // Write the PM2 ecosystem JSON for this user
      const ecosystemPath = path.join(ENVS_DIR, `ecosystem-u${slot}.json`);
      fs.writeFileSync(ecosystemPath, JSON.stringify({ apps }, null, 2), {
        mode: 0o600,
      });

      // Start via PM2
      await runCmd("pm2", ["start", ecosystemPath]);
      await runCmd("pm2", ["save"]);

      setBotsRunning(address, true);

      return res.json({ ok: true, slot, basePort });
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/stop-bots ────────────────────────────────────────────

router.post(
  "/:address/stop-bots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const slot = userSlot(user.bot_wallet_index);

      // Stop (but keep) all PM2 processes for this user
      for (const bot of BOT_DEFS) {
        const pmName = `${bot.name}-u${slot}`;
        try {
          await runCmd("pm2", ["stop", pmName]);
        } catch {
          // Process may not exist yet — ignore
        }
      }

      setBotsRunning(address, false);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/convert-funds ───────────────────────────────────────
// Triggers a USDT → USDC.e swap for the user's bot wallet via the treasury.

router.post(
  "/:address/convert-funds",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }

      const { amountUsdt } = req.body as { amountUsdt?: string };

      const swapRes = await fetch(`${WDK_TREASURY_URL}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index, amountUsdt }),
      });

      if (!swapRes.ok) {
        const body = await swapRes.text();
        return res
          .status(502)
          .json({ error: `Treasury swap failed (${swapRes.status}): ${body}` });
      }

      const result = await swapRes.json();
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ── PUT /users/:address/autonomous ───────────────────────────────────────────
// Toggle autonomous USDT→USDC.e auto-swap mode.

router.put("/:address/autonomous", (req: Request, res: Response) => {
  const { address } = req.params;
  const user = getUser(address);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }

  setAutonomousMode(address, enabled);
  return res.json({ ok: true, autonomousMode: enabled });
});

// ── GET /users/:address/balance ───────────────────────────────────────────────
// Returns USDT, USDC.e and native POL balances for the bot wallet.

router.get(
  "/:address/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });

      const balRes = await fetch(`${WDK_TREASURY_URL}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });

      if (!balRes.ok) {
        const body = await balRes.text();
        return res.status(502).json({
          error: `Treasury balance failed (${balRes.status}): ${body}`,
        });
      }

      return res.json(await balRes.json());
    } catch (err) {
      return next(err);
    }
  },
);

// ── POST /users/:address/withdraw ─────────────────────────────────────────────
// Full withdrawal flow:
//   1. Optionally stop PM2 bots
//   2. Swap all USDC.e → USDT via treasury /swap-reverse
//   3. Transfer USDT from bot wallet → user's MetaMask address

router.post(
  "/:address/withdraw",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const { amountUsdt, stopBots: doStopBots } = req.body as {
        amountUsdt?: string;
        stopBots?: boolean;
      };

      const user = getUser(address);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.bot_wallet_address) {
        return res.status(400).json({ error: "Bot wallet not yet derived" });
      }

      // ── Step 1: Optionally stop bots ───────────────────────────────────────

      if (doStopBots && user.bots_running === 1) {
        const slot = userSlot(user.bot_wallet_index);
        for (const bot of BOT_DEFS) {
          const pmName = `${bot.name}-u${slot}`;
          try {
            await runCmd("pm2", ["stop", pmName]);
          } catch {
            // Process may not exist — ignore
          }
        }
        setBotsRunning(address, false);
      }

      // ── Step 2: Swap USDC.e → USDT (skip gracefully if no balance) ─────────

      let swapTxHash: string | undefined;
      let usdceSwapped: string | undefined;
      let usdtReceived: string | undefined;

      const swapRes = await fetch(`${WDK_TREASURY_URL}/swap-reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: user.bot_wallet_index }),
      });

      if (swapRes.ok) {
        const swapResult = (await swapRes.json()) as {
          txHash: string;
          usdceSwapped: string;
          usdtReceived: string;
        };
        swapTxHash = swapResult.txHash;
        usdceSwapped = swapResult.usdceSwapped;
        usdtReceived = swapResult.usdtReceived;
      } else {
        const body = await swapRes.text();
        // "No USDC.e balance to swap" is expected when user only has USDT
        if (!body.includes("No USDC.e balance")) {
          return res.status(502).json({
            error: `USDC.e → USDT swap failed (${swapRes.status}): ${body}`,
          });
        }
      }

      // ── Step 3: Transfer USDT → user's MetaMask address ────────────────────

      const withdrawBody: {
        index: number;
        toAddress: string;
        amountUsdt?: string;
      } = {
        index: user.bot_wallet_index,
        toAddress: address, // always send to the user's own MetaMask address
      };
      if (amountUsdt) withdrawBody.amountUsdt = amountUsdt;

      const withdrawRes = await fetch(`${WDK_TREASURY_URL}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withdrawBody),
      });

      if (!withdrawRes.ok) {
        const body = await withdrawRes.text();
        return res.status(502).json({
          error: `Withdrawal transfer failed (${withdrawRes.status}): ${body}`,
        });
      }

      const withdrawResult = (await withdrawRes.json()) as {
        txHash: string;
        from: string;
        to: string;
        amount: string;
      };

      return res.json({
        swapTxHash,
        usdceSwapped,
        usdtReceived,
        withdrawTxHash: withdrawResult.txHash,
        amountWithdrawn: withdrawResult.amount,
        to: withdrawResult.to,
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
