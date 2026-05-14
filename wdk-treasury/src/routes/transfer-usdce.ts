/**
 * routes/transfer-usdce.ts
 *
 * POST /transfer-usdce
 *
 * Transfers USDC.e from one bot EOA (by HD wallet index) to any Ethereum
 * address.  Requires the source EOA to have POL for gas.
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:
 *   {
 *     fromIndex:    number  — HD wallet index (must be >= 10)
 *     toAddress:    string  — recipient 0x address
 *     amountUsdce?: string  — decimal, e.g. "15.00"; omit to send full balance
 *   }
 *
 * Response:
 *   { txHash: string, from: string, to: string, amount: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import { getAccount, parseUsdT, formatUsdT } from "../wdk.js";

const USDCE_TOKEN_ADDRESS =
  process.env["USDCE_TOKEN_ADDRESS"] ??
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;
  try {
    const { fromIndex, toAddress, amountUsdce } = req.body as {
      fromIndex?: unknown;
      toAddress?: unknown;
      amountUsdce?: unknown;
    };

    // ── Input validation ────────────────────────────────────────────────────

    if (
      typeof fromIndex !== "number" ||
      !Number.isInteger(fromIndex) ||
      fromIndex < 10
    ) {
      return res.status(400).json({
        error:
          "fromIndex must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    if (
      typeof toAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(toAddress)
    ) {
      return res.status(400).json({
        error: "Invalid toAddress — must be a valid 0x Ethereum address",
      });
    }

    // ── Derive source account ───────────────────────────────────────────────

    account = await getAccount(fromIndex);
    const fromAddr: string = await account.getAddress();

    // ── Fetch balances ──────────────────────────────────────────────────────

    const [usdceBalanceRaw, nativeBalanceRaw] = await Promise.all([
      account.getTokenBalance(USDCE_TOKEN_ADDRESS) as Promise<bigint>,
      account.getBalance() as Promise<bigint>,
    ]);
    const usdceBalance = BigInt(usdceBalanceRaw);
    const nativeBalance = BigInt(nativeBalanceRaw);

    if (nativeBalance === 0n) {
      return res.status(400).json({
        error: "No gas",
        message: "Source bot wallet has no POL to pay the transaction fee.",
      });
    }

    // ── Determine transfer amount ────────────────────────────────────────────

    let amount: bigint;
    if (amountUsdce !== undefined && amountUsdce !== null) {
      try {
        amount = parseUsdT(String(amountUsdce));
      } catch (err: unknown) {
        return res.status(400).json({
          error: "Invalid amountUsdce",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (amount > usdceBalance) {
        return res.status(400).json({
          error: "Insufficient balance",
          message: `Wallet has ${formatUsdT(usdceBalance)} USDC.e but ${formatUsdT(amount)} was requested.`,
        });
      }
    } else {
      amount = usdceBalance;
      if (amount === 0n) {
        return res.status(400).json({
          error: "No USDC.e balance to transfer",
        });
      }
    }

    // ── Execute transfer ────────────────────────────────────────────────────

    const result = await account.transfer({
      token: USDCE_TOKEN_ADDRESS,
      recipient: toAddress,
      amount,
    });

    return res.status(200).json({
      txHash: result.hash,
      from: fromAddr,
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
