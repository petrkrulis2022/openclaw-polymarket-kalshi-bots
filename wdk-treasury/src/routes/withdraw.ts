/**
 * routes/withdraw.ts
 *
 * POST /withdraw
 *
 * Transfers USDT from a user bot wallet (index >= 10) to an external address
 * (e.g. the user's MetaMask wallet).
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, toAddress: string, amountUsdt?: string }
 *           index      — HD wallet index (must be >= 10)
 *           toAddress  — recipient Ethereum address (0x…)
 *           amountUsdt — optional; omit to send the full USDT balance
 *
 * Response: { txHash: string, from: string, to: string, amount: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  getAccount,
  USDT_TOKEN_ADDRESS,
  parseUsdT,
  formatUsdT,
} from "../wdk.js";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;
  try {
    const { index, toAddress, amountUsdt } = req.body as {
      index?: unknown;
      toAddress?: unknown;
      amountUsdt?: unknown;
    };

    // ── Input validation ────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    if (
      typeof toAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(toAddress)
    ) {
      return res.status(400).json({
        error: "Invalid toAddress",
        message: "toAddress must be a valid Ethereum address (0x…).",
      });
    }

    // ── Derive account ──────────────────────────────────────────────────────

    account = await getAccount(index);
    const walletAddress: string = await account.getAddress();

    // ── Fetch balances ──────────────────────────────────────────────────────

    const [balanceRaw, nativeBalanceRaw] = await Promise.all([
      account.getTokenBalance(USDT_TOKEN_ADDRESS) as Promise<bigint>,
      account.getBalance() as Promise<bigint>,
    ]);
    const balance = BigInt(balanceRaw);
    const nativeBalance = BigInt(nativeBalanceRaw);

    if (nativeBalance === 0n) {
      return res.status(400).json({
        error: "No gas",
        message: "Bot wallet has no POL to pay the transaction fee.",
      });
    }

    // ── Determine transfer amount ────────────────────────────────────────────

    let amount: bigint;
    if (amountUsdt !== undefined && amountUsdt !== null) {
      try {
        amount = parseUsdT(String(amountUsdt));
      } catch (err: unknown) {
        return res.status(400).json({
          error: "Invalid amountUsdt",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (amount > balance) {
        return res.status(400).json({
          error: "Insufficient balance",
          message: `Wallet has ${formatUsdT(balance)} USDT but ${formatUsdT(amount)} was requested.`,
        });
      }
    } else {
      if (balance === 0n) {
        return res.status(400).json({ error: "No USDT balance to withdraw" });
      }
      amount = balance;
    }

    // ── Execute transfer ────────────────────────────────────────────────────

    const result = await account.transfer({
      token: USDT_TOKEN_ADDRESS,
      recipient: toAddress,
      amount,
    });

    return res.status(200).json({
      txHash: result.hash,
      from: walletAddress,
      to: toAddress,
      amount: formatUsdT(amount),
    });
  } catch (err) {
    return next(err);
  } finally {
    try {
      account?.dispose?.();
    } catch {}
  }
});

export default router;
