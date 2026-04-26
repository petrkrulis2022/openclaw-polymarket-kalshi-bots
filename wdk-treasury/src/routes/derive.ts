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
 * Response: { address: string, signerKey: string }   (signerKey = 32-byte hex)
 */

import { Router, Request, Response, NextFunction } from "express";
import { getAccount } from "../wdk.js";

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
    const address: string = await account.getAddress();
    // keyPair.privateKey is a 32-byte Uint8Array/Buffer
    const privBuf: Uint8Array = account.keyPair.privateKey;
    const signerKey = Buffer.from(privBuf).toString("hex");

    return res.json({ address, signerKey });
  } catch (err) {
    return next(err);
  } finally {
    try {
      account?.dispose?.();
    } catch {}
  }
});

export default router;
