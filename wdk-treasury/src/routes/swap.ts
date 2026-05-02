/**
 * routes/swap.ts
 *
 * POST /swap
 *
 * Swaps USDT → USDC.e for a user bot wallet via Uniswap V3 SwapRouter02 on
 * Polygon.  Uses the stable-pair fee tier (100 = 0.01%).
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, amountUsdt?: string }
 *           index       — HD wallet index (must be >= 10)
 *           amountUsdt  — optional decimal string, e.g. "50.5".
 *                         Omit to swap the entire USDT balance.
 *
 * Response: { txHash: string, usdtSwapped: string, usdceReceived: string }
 */

import { Router, Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import {
  SEED_PHRASE,
  USDT_TOKEN_ADDRESS,
  POLYGON_RPC,
  parseUsdT,
  formatUsdT,
} from "../wdk.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const USDCE_TOKEN_ADDRESS =
  process.env["USDCE_TOKEN_ADDRESS"] ??
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Uniswap V3 SwapRouter02 (same address on mainnet/polygon)
const SWAP_ROUTER_ADDRESS = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

// Stable pair fee tier: 0.01% (USDT/USDC.e)
const POOL_FEE = 100;

// Minimal ABI slices — only the functions we call
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
] as const;

const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, amountUsdt } = req.body as {
      index?: unknown;
      amountUsdt?: unknown;
    };

    // ── Input validation ────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    // ── Derive signer key and wallet address using BIP-44 path ─────────────

    const hdWallet = ethers.HDNodeWallet.fromPhrase(
      SEED_PHRASE,
      undefined,
      `m/44'/60'/0'/0/${index}`,
    );
    const walletAddress = hdWallet.address;

    // ── Build ethers signer ─────────────────────────────────────────────────

    const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    const signer = new ethers.Wallet(hdWallet.privateKey, provider);

    // ── Determine swap amount ────────────────────────────────────────────────

    const usdtContract = new ethers.Contract(
      USDT_TOKEN_ADDRESS,
      ERC20_ABI,
      signer,
    );

    let amountIn: bigint;
    if (amountUsdt !== undefined && amountUsdt !== null) {
      try {
        amountIn = parseUsdT(String(amountUsdt));
      } catch (err: unknown) {
        return res.status(400).json({
          error: "Invalid amountUsdt",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (amountIn <= 0n) {
        return res.status(400).json({ error: "amountUsdt must be positive" });
      }
    } else {
      // Swap entire USDT balance
      amountIn = (await usdtContract.balanceOf(walletAddress)) as bigint;
    }

    if (amountIn === 0n) {
      return res.status(400).json({ error: "No USDT balance to swap" });
    }

    // ── Step A: Approve SwapRouter02 to spend USDT ───────────────────────────

    const currentAllowance = (await usdtContract.allowance(
      walletAddress,
      SWAP_ROUTER_ADDRESS,
    )) as bigint;

    if (currentAllowance < amountIn) {
      const approveTx = await usdtContract.approve(
        SWAP_ROUTER_ADDRESS,
        amountIn,
      );
      await (approveTx as ethers.TransactionResponse).wait(1);
    }

    // ── Step B: exactInputSingle USDT → USDC.e ───────────────────────────────

    const swapRouter = new ethers.Contract(
      SWAP_ROUTER_ADDRESS,
      SWAP_ROUTER_ABI,
      signer,
    );

    const swapTx = await swapRouter.exactInputSingle({
      tokenIn: USDT_TOKEN_ADDRESS,
      tokenOut: USDCE_TOKEN_ADDRESS,
      fee: POOL_FEE,
      recipient: walletAddress,
      amountIn,
      amountOutMinimum: 0n, // stable pair — minimal slippage expected
      sqrtPriceLimitX96: 0n,
    });

    const receipt = await (swapTx as ethers.TransactionResponse).wait(1);

    // Parse amountOut from the Transfer event on USDC.e contract
    // (Transfer from SwapRouter to walletAddress)
    const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
    let usdceReceived = 0n;
    if (receipt) {
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() === USDCE_TOKEN_ADDRESS.toLowerCase() &&
          log.topics[0] === ERC20_TRANSFER_TOPIC &&
          log.topics[2]?.toLowerCase() ===
            ethers.zeroPadValue(walletAddress, 32).toLowerCase()
        ) {
          usdceReceived = BigInt(log.data);
          break;
        }
      }
    }

    return res.json({
      txHash: receipt?.hash ?? (swapTx as ethers.TransactionResponse).hash,
      usdtSwapped: formatUsdT(amountIn),
      usdceReceived: formatUsdT(usdceReceived),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
