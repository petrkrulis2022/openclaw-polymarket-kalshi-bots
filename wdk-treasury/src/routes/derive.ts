/**
 * routes/derive.ts
 *
 * POST /derive
 *
 * Derives an EVM wallet at the given HD index and returns its address and
 * private key hex string.  This endpoint is **internal-only** (should never
 * be exposed via the Cloudflare tunnel or any public-facing proxy).
 *
 * Body: { index: number }
 * Response: { address: string, signerKey: string }   (signerKey = 32-byte hex, no 0x prefix)
 */

import { Router, Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { SEED_PHRASE } from "../wdk.js";

const router = Router();

router.post("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index } = req.body as { index?: unknown };

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    // Derive wallet using BIP-44 path — same derivation the WDK EVM wallet uses.
    const wallet = ethers.HDNodeWallet.fromPhrase(
      SEED_PHRASE,
      undefined,
      `m/44'/60'/0'/0/${index}`,
    );

    // Return the key without 0x prefix so callers can prepend as needed.
    return res.json({
      address: wallet.address,
      signerKey: wallet.privateKey.slice(2),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
