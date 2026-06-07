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
 *   { orderId: string, price: number, size: number }
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  HDNodeWallet,
  Mnemonic,
  AbiCoder,
  keccak256,
  concat,
  toBeHex,
  zeroPadValue,
  getCreate2Address,
} from "ethers";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient, Chain, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { SEED_PHRASE } from "../wdk.js";

const CLOB_HOST = "https://clob.polymarket.com";

// ── Deposit wallet address derivation (mirrors redeem.ts) ─────────────────────
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPL = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

function initCodeHashERC1967(implementation: string, args: string): string {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  return keccak256(
    concat([
      toBeHex(combined, 10),
      implementation,
      "0x6009",
      ERC1967_CONST2,
      ERC1967_CONST1,
      args,
    ]),
  );
}

function computeDepositWalletAddress(eoaAddress: string): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const walletId = zeroPadValue(eoaAddress, 32);
  const args = abiCoder.encode(
    ["address", "bytes32"],
    [DEPOSIT_WALLET_FACTORY, walletId],
  );
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967(DEPOSIT_WALLET_IMPL, args);
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, bytecodeHash);
}

// ─────────────────────────────────────────────────────────────────────────────

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
    const depositWalletAddress = computeDepositWalletAddress(account.address);

    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    console.log(`[sell] index=${index} eoa=${account.address} funder=${depositWalletAddress} tokenId=${tokenId.slice(0, 16)}… size=${sizeNum}`);

    // Build CLOB client with POLY_1271 — EOA signs on behalf of deposit wallet
    const tempClient = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: signer as any,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWalletAddress,
    });
    const creds = await tempClient.createOrDeriveApiKey();

    const client = new ClobClient({
      host: CLOB_HOST,
      chain: Chain.POLYGON,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signer: signer as any,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWalletAddress,
    });

    // Get best bid from order book (filter out floor bids < 2¢ to avoid dust)
    const book = await client.getOrderBook(tokenId);
    const bids = (book.bids ?? [])
      .map((b: { price: string; size: string }) => parseFloat(b.price))
      .filter((p) => p >= 0.02)
      .sort((a, b) => b - a);
    const bestBid = bids[0] ?? 0;
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
    console.log(`[sell] order placed orderId=${orderId} price=${sellPrice} size=${sellSize}`);

    return res.json({ orderId, price: sellPrice, size: sellSize });
  } catch (err) {
    next(err);
  }
});

export default router;
