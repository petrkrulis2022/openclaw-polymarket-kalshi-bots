/**
 * routes/deposit-polymarket.ts
 *
 * POST /deposit-polymarket
 *
 * Transfers USDC.e from a user bot wallet (index >= 10) to the user's
 * Polymarket proxy wallet address so the bots have capital to trade.
 *
 * Uses ethers.js directly (bypassing WDK signing) to avoid WDK memory-safe
 * key disposal issues that cause "Uint8Array expected" errors.
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
import {
  ethers,
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Contract,
} from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

const USDCE_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
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

    // ── Derive wallet via standard ethers.js HD derivation ────────────────────

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const walletAddress = wallet.address;
    const usdce = new Contract(USDCE_TOKEN_ADDRESS, ERC20_ABI, wallet);

    // ── Fetch balances ────────────────────────────────────────────────────────

    const [balance, nativeBalance] = await Promise.all([
      usdce.balanceOf(walletAddress) as Promise<bigint>,
      provider.getBalance(walletAddress),
    ]);

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

    // ── Determine transfer amount ─────────────────────────────────────────────

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

    const tx = await usdce.transfer(proxyWalletAddress, transferAmount);
    const receipt = await tx.wait();
    const hash: string = receipt?.hash ?? tx.hash;

    const amountFormatted = (Number(transferAmount) / 1_000_000).toFixed(6);

    return res.json({
      txHash: hash,
      from: walletAddress,
      to: proxyWalletAddress,
      amount: amountFormatted,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
