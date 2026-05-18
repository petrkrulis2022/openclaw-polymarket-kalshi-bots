/**
 * redeem-ceasefire.ts
 *
 * One-time script: redeems the unredeemed "US x Iran ceasefire by April 7?"
 * winning position (331 YES tokens) from the old EOA wallet.
 *
 * Run:
 *   cd bots/resolution-lag && npx tsx scripts/redeem-ceasefire.ts
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  zeroHash,
} from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CTF_CONTRACT_ADDRESS =
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const PUSD_TOKEN_ADDRESS =
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const USDCE_TOKEN_ADDRESS =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

const CTF_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
]);

// Position data from Polymarket API
const CONDITION_ID =
  "0x4c5701bcde0b8fb7d7f48c8e9d20245a6caa58c61a77f981fad98f2bfa0b1bc7" as const;
const TOKEN_ID =
  "82855088893985825781350466813737280564000275725006328179621744619327480699369";
const OUTCOME_INDEX = 0; // YES = first outcome (index 0)

async function main() {
  const rawKey = process.env["BOT_SIGNER_KEY"];
  if (!rawKey) {
    console.error("BOT_SIGNER_KEY not set in .env");
    process.exit(1);
  }

  const key = (
    rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(key);

  console.log(`Wallet: ${account.address}`);
  console.log(`Condition: ${CONDITION_ID}`);
  console.log(`Outcome index: ${OUTCOME_INDEX} (YES)`);

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(POLYGON_RPC),
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC),
  });

  const indexSet = BigInt(1) << BigInt(OUTCOME_INDEX); // 1n for outcome 0

  // Auto-detect collateral token (pUSD vs USDC.e) from tokenId
  let collateralToken: `0x${string}` = PUSD_TOKEN_ADDRESS;
  const collectionId = await publicClient.readContract({
    address: CTF_CONTRACT_ADDRESS,
    abi: CTF_ABI,
    functionName: "getCollectionId",
    args: [zeroHash, CONDITION_ID, indexSet],
  });
  const usdcePosId = await publicClient.readContract({
    address: CTF_CONTRACT_ADDRESS,
    abi: CTF_ABI,
    functionName: "getPositionId",
    args: [USDCE_TOKEN_ADDRESS, collectionId],
  });
  if (usdcePosId === BigInt(TOKEN_ID)) {
    collateralToken = USDCE_TOKEN_ADDRESS;
    console.log("Collateral: USDC.e");
  } else {
    console.log("Collateral: pUSD");
  }

  console.log("Submitting redeemPositions transaction…");
  const txHash = await walletClient.writeContract({
    address: CTF_CONTRACT_ADDRESS,
    abi: CTF_ABI,
    functionName: "redeemPositions",
    args: [collateralToken, zeroHash, CONDITION_ID, [indexSet]],
  });

  console.log(`Transaction submitted: ${txHash}`);
  console.log("Waiting for confirmation…");

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(
    `Confirmed in block ${receipt.blockNumber} — status: ${receipt.status}`,
  );

  if (receipt.status === "success") {
    console.log(
      "✅ Redemption successful! ~$331 USDC should now be in the wallet.",
    );
  } else {
    console.error("❌ Transaction reverted.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
