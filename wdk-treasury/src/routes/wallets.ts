/**
 * GET /wallets
 *
 * Returns addresses and USD₮ balances for all four wallets:
 *   - treasury (index 0)
 *   - bot 1    (index 1, Polymarket market-maker)
 *   - bot 2    (index 2, Polymarket–Kalshi arb)
 *   - bot 3    (index 3, Polymarket copy-trader)
 *
 * Balances are fetched via WDK's account.getTokenBalance(), which queries
 * the Polygon RPC directly — no separate indexer key required.
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  getAccount,
  WALLET_INDEX,
  USDT_TOKEN_ADDRESS,
  formatUsdT,
} from "../wdk.js";

const router = Router();

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let treasury: any = null,
    bot1: any = null,
    bot2: any = null,
    bot3: any = null;

  try {
    // Derive all four accounts in parallel
    [treasury, bot1, bot2, bot3] = await Promise.all([
      getAccount(WALLET_INDEX.treasury),
      getAccount(WALLET_INDEX.bot1),
      getAccount(WALLET_INDEX.bot2),
      getAccount(WALLET_INDEX.bot3),
    ]);

    // Fetch all addresses + token balances in parallel
    const [
      treasuryAddress,
      treasuryBalance,
      bot1Address,
      bot1Balance,
      bot2Address,
      bot2Balance,
      bot3Address,
      bot3Balance,
    ] = await Promise.all([
      treasury.getAddress(),
      treasury.getTokenBalance(USDT_TOKEN_ADDRESS),
      bot1.getAddress(),
      bot1.getTokenBalance(USDT_TOKEN_ADDRESS),
      bot2.getAddress(),
      bot2.getTokenBalance(USDT_TOKEN_ADDRESS),
      bot3.getAddress(),
      bot3.getTokenBalance(USDT_TOKEN_ADDRESS),
    ]);

    res.json({
      treasury: {
        address: treasuryAddress,
        usdTBalance: formatUsdT(BigInt(treasuryBalance)),
      },
      bots: [
        {
          id: 1,
          address: bot1Address,
          usdTBalance: formatUsdT(BigInt(bot1Balance)),
        },
        {
          id: 2,
          address: bot2Address,
          usdTBalance: formatUsdT(BigInt(bot2Balance)),
        },
        {
          id: 3,
          address: bot3Address,
          usdTBalance: formatUsdT(BigInt(bot3Balance)),
        },
      ],
    });
  } catch (err) {
    next(err);
  } finally {
    // Clear derived private keys from memory
    for (const acc of [treasury, bot1, bot2, bot3]) {
      try {
        acc?.dispose?.();
      } catch {}
    }
  }
});

export default router;
