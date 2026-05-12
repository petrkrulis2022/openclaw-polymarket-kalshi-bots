/**
 * routes/rescue-safe-usdc.ts
 *
 * POST /rescue-safe-usdc
 *
 * Rescues USDC.e that is stuck inside a Gnosis Safe proxy wallet by:
 *   1. Signing a Gnosis Safe transaction (EIP-712) as the Safe owner (EOA)
 *   2. Calling GnosisSafe.execTransaction() from the EOA to transfer USDC.e
 *      from the Safe back to the EOA
 *   3. EOA approves CTF Exchange → calls Exchange.deposit() to make it tradeable
 *
 * The EOA pays all gas (it has POL). The Safe does NOT need any POL.
 *
 * Only for 1-of-1 Gnosis Safes where the sole owner is the bot EOA at `index`.
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, safeAddress: string }
 *           index       — HD wallet index of the EOA that owns the Safe (>= 10)
 *           safeAddress — Gnosis Safe contract address (0x…)
 *
 * Response: {
 *   rescued: string,   // USDC.e amount moved from Safe → EOA
 *   deposited: string, // USDC.e amount deposited into Exchange
 *   safeTxHash: string,
 *   depositTxHash: string,
 * }
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Contract,
  Interface,
} from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

const USDCE_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const POLYGON_CHAIN_ID = 137;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const EXCHANGE_ABI = [
  "function deposit(uint256 amount) external",
];

// Minimal Gnosis Safe ABI — just the functions we need
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes memory signatures) external payable returns (bool success)",
];

// EIP-712 types for Gnosis Safe (v1.3.0+)
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, safeAddress } = req.body as {
      index?: unknown;
      safeAddress?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    if (
      typeof safeAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(safeAddress)
    ) {
      return res.status(400).json({
        error: "Invalid safeAddress",
        message: "safeAddress must be a valid Ethereum address (0x…).",
      });
    }

    // ── Derive wallet ─────────────────────────────────────────────────────────

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const eoaAddress = wallet.address;
    const safe = new Contract(safeAddress, SAFE_ABI, wallet);
    const usdce = new Contract(USDCE_TOKEN_ADDRESS, ERC20_ABI, wallet);

    // ── Verify EOA owns the Safe ──────────────────────────────────────────────

    const [owners, threshold, safeNonce, safeUsdceBalance, eoaBalance] =
      await Promise.all([
        safe.getOwners() as Promise<string[]>,
        safe.getThreshold() as Promise<bigint>,
        safe.nonce() as Promise<bigint>,
        (new Contract(USDCE_TOKEN_ADDRESS, ERC20_ABI, provider)).balanceOf(safeAddress) as Promise<bigint>,
        provider.getBalance(eoaAddress),
      ]);

    const eoaIsOwner = owners.some(
      (o) => o.toLowerCase() === eoaAddress.toLowerCase(),
    );
    if (!eoaIsOwner) {
      return res.status(400).json({
        error: "EOA is not an owner of this Safe",
        owners,
        eoa: eoaAddress,
      });
    }

    if (threshold > 1n) {
      return res.status(400).json({
        error: `Safe threshold is ${threshold}; only 1-of-N Safes are supported`,
      });
    }

    if (safeUsdceBalance === 0n) {
      return res.status(200).json({
        message: "Safe has no USDC.e to rescue",
        safeAddress,
        safeUsdceBalance: "0",
      });
    }

    if (eoaBalance === 0n) {
      return res.status(400).json({
        error: "EOA has no POL for gas",
        eoa: eoaAddress,
      });
    }

    // ── Step 1: Execute Safe tx to transfer USDC.e from Safe → EOA ───────────
    // Encode USDC.e.transfer(eoaAddress, safeUsdceBalance)

    const erc20Interface = new Interface(ERC20_ABI);
    const transferData = erc20Interface.encodeFunctionData("transfer", [
      eoaAddress,
      safeUsdceBalance,
    ]);

    // Build the Safe EIP-712 message
    const safeTxMessage = {
      to: USDCE_TOKEN_ADDRESS,
      value: 0n,
      data: transferData,
      operation: 0, // CALL
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: safeNonce,
    };

    const safeDomain = {
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: safeAddress,
    };

    // Sign the Safe transaction hash with EOA (EIP-712)
    const safeTxSignature = await wallet.signTypedData(
      safeDomain,
      SAFE_TX_TYPES,
      safeTxMessage,
    );

    // Execute the Safe transaction — EOA pays gas, Safe executes the inner call
    const execTx = await safe.execTransaction(
      safeTxMessage.to,
      safeTxMessage.value,
      safeTxMessage.data,
      safeTxMessage.operation,
      safeTxMessage.safeTxGas,
      safeTxMessage.baseGas,
      safeTxMessage.gasPrice,
      safeTxMessage.gasToken,
      safeTxMessage.refundReceiver,
      safeTxSignature,
    );
    const execReceipt = await execTx.wait(1);
    const safeTxHash: string = execReceipt?.hash ?? execTx.hash;

    const rescuedAmount = (Number(safeUsdceBalance) / 1_000_000).toFixed(6);

    // ── Step 2: Approve + deposit the rescued USDC.e into CTF Exchange ────────

    const approveTx = await usdce.approve(CTF_EXCHANGE_ADDRESS, safeUsdceBalance);
    await approveTx.wait(1);

    const exchange = new Contract(CTF_EXCHANGE_ADDRESS, EXCHANGE_ABI, wallet);
    const depositTx = await exchange.deposit(safeUsdceBalance);
    const depositReceipt = await depositTx.wait(1);
    const depositTxHash: string = depositReceipt?.hash ?? depositTx.hash;

    return res.json({
      rescued: rescuedAmount,
      deposited: rescuedAmount,
      safeTxHash,
      depositTxHash,
      from: safeAddress,
      to: eoaAddress,
      exchange: CTF_EXCHANGE_ADDRESS,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
