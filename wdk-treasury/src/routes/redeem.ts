/**
 * routes/redeem.ts
 *
 * POST /redeem
 *
 * Redeems resolved ERC-1155 conditional token positions back to pUSD.
 * Calls the CTF Exchange redeemPositions() directly from the deposit wallet.
 *
 * Body:
 *   {
 *     index:        number   — HD wallet index of the bot EOA (>= 10)
 *     conditionId:  string   — bytes32 hex (from Polymarket positions API)
 *     outcomeIndex: number   — 0 = first outcome (YES), 1 = second (NO), etc.
 *     negativeRisk: boolean  — true → use NEG_RISK_CTF_EXCHANGE
 *   }
 *
 * Response:
 *   { txHash: string, redeemed: string }
 *
 * How Polymarket CTF redemption works:
 *   - indexSets: each bit represents an outcome index to redeem
 *     - outcomeIndex 0 → indexSets = [1]  (binary: 01)
 *     - outcomeIndex 1 → indexSets = [2]  (binary: 10)
 *     - outcomeIndex 2 → indexSets = [4]  (binary: 100) etc.
 *   - CTF.redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets)
 *     where parentCollectionId = bytes32(0) for top-level positions
 *
 * The deposit wallet (POLY_1271 proxy) holds the ERC-1155 tokens.
 * The EOA (derived from HD index) calls execute() on the deposit wallet proxy
 * to trigger redeemPositions on the CTF contract.
 *
 * Deposit wallet execute() ABI (ERC-1967 Polymarket proxy):
 *   execute(address to, uint256 value, bytes calldata data)
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Contract,
  Interface,
  zeroPadValue,
  toBeHex,
} from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";
import { keccak256, AbiCoder, concat, getCreate2Address } from "ethers";

// ── Contract addresses (Polygon mainnet) ─────────────────────────────────────

const PUSD_TOKEN_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF_CONTRACT_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// Deposit wallet factory / impl for computing CREATE2 address
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPL = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const CTF_ABI = [
  // redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets)
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

// Deposit wallet proxy execute (Polymarket POLY_1271 / ERC-1967 proxy)
const DEPOSIT_WALLET_ABI = [
  "function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory)",
];

// ── Deposit wallet address derivation ────────────────────────────────────────

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
  const args = AbiCoder.defaultAbiCoder().encode(["address"], [eoaAddress]);
  const salt = zeroPadValue(eoaAddress, 32);
  const initCodeHash = initCodeHashERC1967(DEPOSIT_WALLET_IMPL, args);
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, initCodeHash);
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, conditionId, outcomeIndex, negativeRisk } = req.body as {
      index?: unknown;
      conditionId?: unknown;
      outcomeIndex?: unknown;
      negativeRisk?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error: "index must be an integer >= 10",
      });
    }

    if (
      typeof conditionId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(conditionId)
    ) {
      return res.status(400).json({
        error:
          "conditionId must be a valid bytes32 hex string (0x + 64 hex chars)",
      });
    }

    if (
      typeof outcomeIndex !== "number" ||
      !Number.isInteger(outcomeIndex) ||
      outcomeIndex < 0 ||
      outcomeIndex > 255
    ) {
      return res.status(400).json({
        error: "outcomeIndex must be a non-negative integer",
      });
    }

    // ── Derive deposit wallet address ─────────────────────────────────────────

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const eoaAddress = wallet.address;
    const depositWalletAddress = computeDepositWalletAddress(eoaAddress);

    // ── Build CTF redeemPositions calldata ────────────────────────────────────

    // indexSets: bit N set = redeem outcome N. outcomeIndex 0 → 1, 1 → 2, 2 → 4 …
    const indexSets = [BigInt(1) << BigInt(outcomeIndex)];
    const parentCollectionId = zeroPadValue("0x00", 32); // bytes32(0)

    const ctfInterface = new Interface(CTF_ABI);
    const redeemCalldata = ctfInterface.encodeFunctionData("redeemPositions", [
      PUSD_TOKEN_ADDRESS,
      parentCollectionId,
      conditionId,
      indexSets,
    ]);

    // ── Call execute() on deposit wallet from EOA ─────────────────────────────

    const depositWallet = new Contract(
      depositWalletAddress,
      DEPOSIT_WALLET_ABI,
      wallet,
    );

    const tx = await depositWallet.execute(
      CTF_CONTRACT_ADDRESS,
      0n,
      redeemCalldata,
    );

    const receipt = await tx.wait();

    return res.json({
      txHash: receipt.hash,
      depositWallet: depositWalletAddress,
      conditionId,
      outcomeIndex,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
