/**
 * routes/balance.ts
 *
 * POST /balance
 *
 * Returns USDT, USDC.e and native POL balances for a user bot wallet.
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number }   (must be >= 10)
 * Response: { address, usdt, usdce, nativePol }  (all string, token amounts
 *           formatted with 6 decimals, nativePol in wei as string)
 */

import { Router, Request, Response, NextFunction } from "express";
import { getAccount, USDT_TOKEN_ADDRESS, formatUsdT } from "../wdk.js";

const USDCE_TOKEN_ADDRESS =
  process.env["USDCE_TOKEN_ADDRESS"] ??
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;
  try {
    const { index } = req.body as { index?: unknown };

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    account = await getAccount(index);

    const [address, usdt, usdce, native] = await Promise.all([
      account.getAddress() as Promise<string>,
      account.getTokenBalance(USDT_TOKEN_ADDRESS) as Promise<bigint>,
      account.getTokenBalance(USDCE_TOKEN_ADDRESS) as Promise<bigint>,
      account.getBalance() as Promise<bigint>,
    ]);

    return res.json({
      address,
      usdt: formatUsdT(usdt),
      usdce: formatUsdT(usdce),
      nativePol: native.toString(),
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
