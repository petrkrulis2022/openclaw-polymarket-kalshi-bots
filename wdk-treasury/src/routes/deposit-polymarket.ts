/**
 * routes/deposit-polymarket.ts
 *
 * POST /deposit-polymarket
 *
 * Transfers USDC.e from a user bot wallet (index >= 10) to the user's
 * Polymarket proxy wallet address so the bots have capital to trade.
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, proxyWalletAddress: string, amountUsdce?: string }
 *           index               — HD wallet index (must be >= 10)
 *           proxyWalletAddress  — Polymarket proxy wallet (0x…)
 *           amountUsdce         — optional; omit to send the full USDC.e balance
 *
 * Response: { txHash: string, from: string, to: string, amount: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import { getAccount } from "../wdk.js";

const USDCE_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;
  try {
    const { index, proxyWalletAddress, amountUsdce } = req.body as {
      index?: unknown;
      proxyWalletAddress?: unknown;
      amountUsdce?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    if (
      typeof proxyWalletAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(proxyWalletAddress)
    ) {
      return res.status(400).json({
        error: "Invalid proxyWalletAddress",
        message: "proxyWalletAddress must be a valid Ethereum address (0x…).",
      });
    }

    // ── Derive account ────────────────────────────────────────────────────────

    account = await getAccount(index);
    const walletAddress: string = await account.getAddress();

    // ── Fetch balances ────────────────────────────────────────────────────────

    const [balanceRaw, nativeBalanceRaw] = await Promise.all([
      account.getTokenBalance(USDCE_TOKEN_ADDRESS) as Promise<bigint>,
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

    if (balance === 0n) {
      return res.status(400).json({
        error: "No USDC.e",
        message: "Bot wallet has no USDC.e to deposit.",
      });
    }

    // ── Determine transfer amount ──────────────────────────────────────────────

    let transferAmount: bigint;
    if (
      amountUsdce !== undefined &&
      amountUsdce !== "" &&
      amountUsdce !== null
    ) {
      transferAmount = BigInt(
        Math.round(parseFloat(String(amountUsdce)) * 1_000_000),
      );
      if (transferAmount <= 0n || transferAmount > balance) {
        return res.status(400).json({
          error: "Invalid amount",
          message: `Amount must be between 0 and ${(Number(balance) / 1_000_000).toFixed(6)} USDC.e.`,
        });
      }
    } else {
      // Default: transfer entire USDC.e balance
      transferAmount = balance;
    }

    // ── Execute transfer ──────────────────────────────────────────────────────

    const { hash } = await account.transfer({
      token: USDCE_TOKEN_ADDRESS,
      recipient: proxyWalletAddress,
      amount: transferAmount,
    });

    const amountFormatted = (Number(transferAmount) / 1_000_000).toFixed(6);

    return res.json({
      txHash: hash,
      from: walletAddress,
      to: proxyWalletAddress,
      amount: amountFormatted,
    });
  } catch (err) {
    return next(err);
  } finally {
    try { account?.dispose?.(); } catch (_) { /* ignore dispose errors */ }
  }
});

export default router;
