/**
 * merge.ts — CTF mergePositions caller for in-market-arb bot.
 *
 * After both YES and NO legs fill at combined cost < $1, merge them on-chain to
 * receive $1 USDC.e immediately without waiting for oracle resolution.
 *
 * Calls the ConditionalTokens contract directly from the signing EOA.
 * If the EOA doesn't hold the tokens (i.e., they're in the Gnosis Safe proxy),
 * this will revert — switch to the EIP-712 relayer path in that case.
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
  if (process.env["DRY_RUN"]) {
    console.log(
      `[merge] DRY_RUN — would mergePositions conditionId=${conditionId} amount=${amountShares.toFixed(4)}`,
    );
    return "dry-run";
  }

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
    args: [USDCE, ZERO_HASH, conditionId as `0x${string}`, [...BINARY_PARTITION], amountMicro],
  });

  console.log(`[merge] tx submitted: ${txHash}`);
  return txHash;
}
