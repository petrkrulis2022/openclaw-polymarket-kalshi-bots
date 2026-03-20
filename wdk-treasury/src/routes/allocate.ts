/**
 * POST /allocate
 *
 * Transfers USD₮ from the treasury wallet (index 0) to a bot wallet (index 1–3).
 *
 * Body: { "botId": 1 | 2 | 3, "amountUsdT": "10.5" }
 *
 * Validations:
 *   - botId must be 1, 2, or 3
 *   - amountUsdT must be a positive decimal string
 *   - Treasury must have sufficient USD₮ balance
 *   - Treasury must have POL (native token) for gas
 *
 * Gas note: the TREASURY wallet pays the EVM transaction fee in POL.
 *           Fund it from https://faucet.polygon.technology (Amoy testnet).
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  getAccount,
  WALLET_INDEX,
  USDT_TOKEN_ADDRESS,
  VALID_BOT_IDS,
  botIndexForId,
  parseUsdT,
  formatUsdT,
  type BotId,
} from "../wdk.js";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  const { botId, amountUsdT } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────

  if (
    typeof botId !== "number" ||
    !Number.isInteger(botId) ||
    !VALID_BOT_IDS.has(botId)
  ) {
    return res
      .status(400)
      .json({ error: "Invalid botId", message: "botId must be 1, 2, or 3." });
  }

  let amount: bigint;
  try {
    amount = parseUsdT(String(amountUsdT ?? ""));
  } catch (err: unknown) {
    return res.status(400).json({
      error: "Invalid amountUsdT",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const botWalletIndex = botIndexForId(botId as BotId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let treasuryAccount: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let botAccount: any = null;

  try {
    // Derive both accounts in parallel; we need the bot address as recipient
    [treasuryAccount, botAccount] = await Promise.all([
      getAccount(WALLET_INDEX.treasury),
      getAccount(botWalletIndex),
    ]);

    // Fetch what we need in parallel
    const [treasuryAddress, botAddress, balanceRaw, nativeBalanceRaw] =
      await Promise.all([
        treasuryAccount.getAddress(),
        botAccount.getAddress(),
        treasuryAccount.getTokenBalance(USDT_TOKEN_ADDRESS),
        treasuryAccount.getBalance(), // native POL for gas
      ]);

    // We only needed the bot account for its address; dispose it now
    try {
      botAccount.dispose();
    } catch {}
    botAccount = null;

    const balance = BigInt(balanceRaw);
    const nativeBalance = BigInt(nativeBalanceRaw);

    // ── Balance checks ──────────────────────────────────────────────────────

    if (balance < amount) {
      return res.status(400).json({
        error: "Insufficient balance",
        message: `Treasury has ${formatUsdT(balance)} USD₮ but ${formatUsdT(amount)} was requested.`,
      });
    }

    if (nativeBalance === 0n) {
      return res.status(400).json({
        error: "No gas",
        message:
          "Treasury wallet has no POL to pay the transaction fee. " +
          "Fund it from https://faucet.polygon.technology (Amoy testnet).",
      });
    }

    // ── Execute transfer ────────────────────────────────────────────────────

    const result = await treasuryAccount.transfer({
      token: USDT_TOKEN_ADDRESS,
      recipient: botAddress,
      amount,
    });

    res.status(200).json({
      txHash: result.hash,
      from: treasuryAddress,
      to: botAddress,
      amount: formatUsdT(amount),
      botId,
    });
  } catch (err) {
    next(err);
  } finally {
    try {
      treasuryAccount?.dispose?.();
    } catch {}
    try {
      botAccount?.dispose?.();
    } catch {}
  }
});

export default router;
