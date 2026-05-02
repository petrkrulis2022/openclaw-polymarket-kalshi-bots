/**
 * One-off script: sweep all USDT from treasury wallet (index 0)
 * to the specified recipient address.
 *
 * Usage:  node sweep-treasury.mjs
 */
import "dotenv/config";
import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";

const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const RECIPIENT = "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e";
const RPC = process.env.POLYGON_RPC ?? "https://polygon-bor-rpc.publicnode.com";

if (!process.env.SEED_PHRASE) {
  console.error("ERROR: SEED_PHRASE not found in .env");
  process.exit(1);
}

const wdk = new WDK(process.env.SEED_PHRASE).registerWallet(
  "polygon",
  WalletManagerEvm,
  { provider: RPC },
);

const account = await wdk.getAccount("polygon", 0);
const address = await account.getAddress();
console.log("Treasury address:", address);

const [rawUsdt, rawPol] = await Promise.all([
  account.getTokenBalance(USDT),
  account.getBalance(),
]);

const usdtBalance = BigInt(rawUsdt);
const polBalance = BigInt(rawPol);

console.log("USDT balance:", (Number(usdtBalance) / 1e6).toFixed(6));
console.log("POL balance (gas):", (Number(polBalance) / 1e18).toFixed(6));

if (polBalance === 0n) {
  console.error(
    "ERROR: No POL for gas. Send a small amount of POL to",
    address,
  );
  await account.dispose?.();
  process.exit(1);
}

if (usdtBalance === 0n) {
  console.error("No USDT to send.");
  await account.dispose?.();
  process.exit(0);
}

console.log(
  `\nSending ${(Number(usdtBalance) / 1e6).toFixed(6)} USDT → ${RECIPIENT}`,
);

const result = await account.transfer({
  token: USDT,
  recipient: RECIPIENT,
  amount: usdtBalance,
});

console.log("✅ TX hash:", result.hash);
console.log(`   https://polygonscan.com/tx/${result.hash}`);

await account.dispose?.();
