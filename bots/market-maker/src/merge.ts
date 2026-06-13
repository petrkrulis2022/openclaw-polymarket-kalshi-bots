/**
 * merge.ts — CTF mergePositions caller for the market maker.
 *
 * When both legs of a market fill (we hold matched YES + NO acquired for a
 * combined cost < $1), merging them on-chain returns $1 per pair immediately
 * instead of waiting for oracle resolution, recycling the collateral.
 *
 * The merge is signed by the bot EOA, so it only succeeds when the EOA itself
 * holds the tokens (POLY_EOA mode). In proxy/Safe/1271 mode the proxy holds
 * them and this reverts — callers must gate on `config.canMergeOnchain`.
 */
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config.js";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const BINARY_PARTITION = [1n, 2n] as const;

const CTF_ABI = parseAbi([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external",
]);

export async function mergeYesNo(
  conditionId: string,
  amountShares: number,
): Promise<string> {
  const key = config.polymarket.signerKey;
  if (!key) throw new Error("BOT_SIGNER_KEY not set");

  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`,
  );
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC),
  });

  const amountMicro = BigInt(Math.round(amountShares * 1e6));

  console.log(
    `[merge] mergePositions conditionId=${conditionId} amount=${amountShares.toFixed(4)} shares (${amountMicro} units) from ${account.address}`,
  );

  const txHash = await walletClient.writeContract({
    address: CTF_CONTRACT,
    abi: CTF_ABI,
    functionName: "mergePositions",
    args: [
      USDCE,
      ZERO_HASH,
      conditionId as `0x${string}`,
      [...BINARY_PARTITION],
      amountMicro,
    ],
  });

  console.log(`[merge] tx submitted: ${txHash}`);
  return txHash;
}
