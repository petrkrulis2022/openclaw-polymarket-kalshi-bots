/**
 * routes/sell.ts
 *
 * POST /sell
 *
 * Places a SELL limit order on the Polymarket CLOB for the given token,
 * at the current best bid (or 1¢ floor). Works even when the bot process
 * is offline because it derives credentials directly from the seed phrase.
 *
 * Body:
 *   {
 *     index:   number  — HD wallet index of the bot EOA (>= 10)
 *     tokenId: string  — ERC-1155 token ID (from Polymarket positions API)
 *     size:    number  — number of shares to sell
 *   }
 *
 * Response:
 *   { orderId: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import { HDNodeWallet, Mnemonic } from "ethers";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient, Chain, Side } from "@polymarket/clob-client-v2";
import { SEED_PHRASE } from "../wdk.js";

const CLOB_HOST = "https://clob.polymarket.com";

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, tokenId, size } = req.body as {
      index?: unknown;
      tokenId?: unknown;
      size?: unknown;
    };

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({ error: "index must be an integer >= 10" });
    }
    if (typeof tokenId !== "string" || !tokenId) {
      return res.status(400).json({ error: "tokenId must be a non-empty string" });
    }
    const sizeNum = typeof size === "number" ? size : parseFloat(String(size));
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
      return res.status(400).json({ error: "size must be a positive number" });
    }

    // Derive HD wallet at given index
    const ethersWallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    );
    const privateKey = ethersWallet.privateKey as `0x${string}`;

    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    console.log(`[sell] index=${index} eoa=${account.address} tokenId=${tokenId.slice(0, 16)}… size=${sizeNum}`);

    // Build CLOB client and derive API key
    const tempClient = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: signer as any,
      signatureType: 0, // POLY_EOA
    });
    const creds = await tempClient.createOrDeriveApiKey();

    const client = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: signer as any,
      creds,
      signatureType: 0,
    });

    // Get best bid from order book
    const book = await client.getOrderBook(tokenId);
    const bids = (book.bids ?? []).map((b: { price: string; size: string }) => parseFloat(b.price));
    const bestBid = bids.length > 0 ? Math.max(...bids) : 0;
    const sellPrice = Math.max(0.01, bestBid);

    console.log(`[sell] bestBid=${bestBid} sellPrice=${sellPrice}`);

    // Round size down to 2 decimal places (Polymarket min tick)
    const sellSize = Math.floor(sizeNum * 100) / 100;
    if (sellSize < 1) {
      return res.status(400).json({ error: `Size too small after rounding: ${sellSize}` });
    }

    const order = await client.createAndPostOrder({
      tokenID: tokenId,
      side: Side.SELL,
      price: sellPrice,
      size: sellSize,
    });

    const orderId = (order as { orderID?: string }).orderID ?? "unknown";
    console.log(`[sell] order placed orderId=${orderId}`);

    return res.json({ orderId, price: sellPrice, size: sellSize });
  } catch (err) {
    next(err);
  }
});

export default router;
