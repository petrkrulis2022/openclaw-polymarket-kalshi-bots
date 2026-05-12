/**
 * routes/deposit-polymarket.ts
 *
 * POST /deposit-polymarket
 *
 * Deposits USDC.e from a user bot wallet (index >= 10) into the Polymarket
 * CTF Exchange, crediting the EOA's trading account directly (POLY_EOA mode).
 *
 * Flow: EOA → approve(Exchange, amount) → Exchange.deposit(amount)
 *
 * The Exchange credits the EOA's internal balance. The bot then trades as
 * maker = EOA (POLY_EOA, signatureType=0). No Gnosis Safe proxy required.
 *
 * Uses ethers.js directly (bypassing WDK signing) to avoid WDK memory-safe
 * key disposal issues that cause "Uint8Array expected" errors.
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, proxyWalletAddress?: string, amountUsdce?: string }
 *           index               — HD wallet index (must be >= 10)
 *           proxyWalletAddress  — (legacy, ignored) was the Gnosis Safe address
 *           amountUsdce         — optional; omit to deposit the full USDC.e balance
 *
 * Response: { txHash: string, from: string, exchange: string, amount: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Contract,
} from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

const USDCE_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Polymarket CTF Exchange on Polygon — deposit(uint256) credits msg.sender
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const EXCHANGE_ABI = [
  "function deposit(uint256 amount) external",
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

    // proxyWalletAddress is accepted but no longer used in the transaction
    // (kept for backward compat with callers that still send it)
    if (
      proxyWalletAddress !== undefined &&
      proxyWalletAddress !== null &&
      proxyWalletAddress !== "" &&
      (typeof proxyWalletAddress !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(proxyWalletAddress))
    ) {
      return res.status(400).json({
        error: "Invalid proxyWalletAddress",
        message: "proxyWalletAddress must be a valid Ethereum address (0x…) if provided.",
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
    const exchange = new Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, wallet);

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

    // ── Determine deposit amount ──────────────────────────────────────────────

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
      // Default: deposit entire USDC.e balance
      transferAmount = balance;
    }

    // ── Approve + deposit into Polymarket CTF Exchange ────────────────────────
    // POLY_EOA mode: EOA approves Exchange, calls deposit(amount).
    // Exchange credits the EOA's collateral account. Bots trade as maker=EOA.

    const approveTx = await usdce.approve(CTF_EXCHANGE_ADDRESS, transferAmount);
    await approveTx.wait(1);

    const depositTx = await exchange.deposit(transferAmount);
    const receipt = await depositTx.wait(1);
    const hash: string = receipt?.hash ?? depositTx.hash;

    const amountFormatted = (Number(transferAmount) / 1_000_000).toFixed(6);

    return res.json({
      txHash: hash,
      from: walletAddress,
      exchange: CTF_EXCHANGE_ADDRESS,
      amount: amountFormatted,
      // include for callers that log proxyWalletAddress
      proxyWalletAddress: proxyWalletAddress ?? null,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
