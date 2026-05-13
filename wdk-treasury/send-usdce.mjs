/**
 * One-time script: send 17 USDC.e from deposit wallet to external address
 * via Polymarket gasless relayer (no POL needed).
 *
 * Usage: node send-usdce.mjs
 */

import { createHmac } from "node:crypto";
import {
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Interface,
  zeroPadValue,
  toBeHex,
  keccak256,
  AbiCoder,
  concat,
  getCreate2Address,
} from "ethers";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Try wdk-treasury/.env first (where pm2 saves it), then repo-root fallback
dotenv.config({ path: join(__dirname, ".env") });
dotenv.config({ path: join(__dirname, "../.env") });

const SEED_PHRASE = process.env.SEED_PHRASE ?? process.env.MNEMONIC;
if (!SEED_PHRASE) throw new Error("SEED_PHRASE not set in .env");

// ── Config ────────────────────────────────────────────────────────────────────

const WALLET_INDEX = 15; // HD index of the bot EOA
const RECIPIENT = "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e";
const AMOUNT_USDCE = 17_000_000n; // 17 USDC.e (6 decimals)

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPL = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;
const CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";
const RELAYER_URL = "https://relayer-v2.polymarket.com";
const CLOB_MSG_TO_SIGN = "This message attests that I control the given wallet";

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeDepositWalletAddress(eoaAddress) {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const walletId = zeroPadValue(eoaAddress, 32);
  const args = abiCoder.encode(
    ["address", "bytes32"],
    [DEPOSIT_WALLET_FACTORY, walletId],
  );
  const salt = keccak256(args);
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  const bytecodeHash = keccak256(
    concat([
      toBeHex(combined, 10),
      DEPOSIT_WALLET_IMPL,
      "0x6009",
      ERC1967_CONST2,
      ERC1967_CONST1,
      args,
    ]),
  );
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, bytecodeHash);
}

function buildHmacSig(secret, ts, method, path, body) {
  let message = `${ts}${method}${path}`;
  if (body !== undefined) message += body;
  const hmac = createHmac("sha256", Buffer.from(secret, "base64"));
  const sig = hmac.update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

async function clobL1Headers(wallet) {
  const ts = Math.floor(Date.now() / 1000);
  const domain = { name: "ClobAuthDomain", version: "1", chainId: CHAIN_ID };
  const types = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };
  const value = {
    address: wallet.address,
    timestamp: ts.toString(),
    nonce: 0,
    message: CLOB_MSG_TO_SIGN,
  };
  const sig = await wallet.signTypedData(domain, types, value);
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${ts}`,
    POLY_NONCE: "0",
  };
}

function clobL2Headers(address, creds, method, path, body) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = buildHmacSig(creds.secret, ts, method, path, body);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

async function deriveOrCreateClobApiKey(wallet) {
  const l1 = await clobL1Headers(wallet);
  const headers = { "Content-Type": "application/json", ...l1 };
  const deriveResp = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    headers,
  });
  if (deriveResp.ok) {
    const body = await deriveResp.json();
    const key = body["apiKey"] ?? body["key"];
    const secret = body["secret"] ?? body["api_secret"];
    if (key && secret)
      return { key, secret, passphrase: body["passphrase"] ?? "" };
  }
  const createResp = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: "POST",
    headers,
  });
  const createBody = await createResp.json();
  const createdKey = createBody["apiKey"] ?? createBody["key"];
  const createdSecret = createBody["secret"] ?? createBody["api_secret"];
  if (!createResp.ok || !createdKey || !createdSecret)
    throw new Error(`CLOB createApiKey failed: ${JSON.stringify(createBody)}`);
  return {
    key: createdKey,
    secret: createdSecret,
    passphrase: createBody["passphrase"] ?? "",
  };
}

async function getOrCreateBuilderApiKey(wallet, clobCreds) {
  const path = "/auth/builder-api-key";
  const eoa = wallet.address;
  const getResp = await fetch(`${CLOB_HOST}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...clobL2Headers(eoa, clobCreds, "GET", path),
    },
  });
  if (getResp.ok) {
    const body = await getResp.json();
    const first = Array.isArray(body) ? body[0] : body;
    const key = first?.["apiKey"] ?? first?.["key"];
    const secret = first?.["secret"] ?? first?.["api_secret"];
    if (key && secret)
      return { key, secret, passphrase: first["passphrase"] ?? "" };
  }
  const bodyStr = "";
  const postResp = await fetch(`${CLOB_HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...clobL2Headers(eoa, clobCreds, "POST", path, bodyStr),
    },
  });
  const postBody = await postResp.json();
  const createdKey = postBody["apiKey"] ?? postBody["key"];
  const createdSecret = postBody["secret"] ?? postBody["api_secret"];
  if (!postResp.ok || !createdKey || !createdSecret)
    throw new Error(`Builder createApiKey failed: ${JSON.stringify(postBody)}`);
  return {
    key: createdKey,
    secret: createdSecret,
    passphrase: postBody["passphrase"] ?? "",
  };
}

async function relayerGet(path, params) {
  const url = new URL(`${RELAYER_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  const body = await resp.json();
  if (!resp.ok)
    throw new Error(
      `Relayer GET ${path} failed (${resp.status}): ${JSON.stringify(body)}`,
    );
  return body;
}

async function relayerPost(path, payload, builderCreds) {
  const bodyStr = JSON.stringify(payload);
  const extraHeaders = {};
  if (builderCreds) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildHmacSig(builderCreds.secret, ts, "POST", path, bodyStr);
    extraHeaders["POLY_BUILDER_API_KEY"] = builderCreds.key;
    extraHeaders["POLY_BUILDER_PASSPHRASE"] = builderCreds.passphrase;
    extraHeaders["POLY_BUILDER_SIGNATURE"] = sig;
    extraHeaders["POLY_BUILDER_TIMESTAMP"] = `${ts}`;
  }
  const resp = await fetch(`${RELAYER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: bodyStr,
  });
  const body = await resp.json();
  if (!resp.ok)
    throw new Error(
      `Relayer POST ${path} failed (${resp.status}): ${JSON.stringify(body)}`,
    );
  return body;
}

async function pollRelayerTx(transactionId, maxPolls = 120, intervalMs = 5000) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let result;
    try {
      result = await relayerGet("/transaction", { id: transactionId });
    } catch {
      continue;
    }
    const txns = Array.isArray(result) ? result : [result];
    const txn = txns[0];
    if (!txn) continue;
    const state = String(txn["state"] ?? txn["status"] ?? "");
    const hash = String(
      txn["transactionHash"] ?? txn["hash"] ?? txn["txHash"] ?? "",
    );
    if (
      [
        "CONFIRMED",
        "STATE_CONFIRMED",
        "MINED",
        "SUCCESS",
        "confirmed",
        "mined",
        "success",
      ].includes(state) ||
      (state === "" && hash.length > 10)
    ) {
      console.log(`[send] Confirmed! hash=${hash}`);
      return hash;
    }
    if (
      state.toUpperCase().includes("FAIL") ||
      ["REVERTED", "reverted"].includes(state)
    )
      throw new Error(`Transaction failed: ${state}`);
    console.log(
      `[send] state=${state} hash=${hash} (poll ${i + 1}/${maxPolls})`,
    );
  }
  throw new Error(`Transaction timed out after ${maxPolls} polls`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const ERC20_IFACE = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

async function main() {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const wallet = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(SEED_PHRASE),
    `m/44'/60'/0'/0/${WALLET_INDEX}`,
  ).connect(provider);

  const eoaAddress = wallet.address;
  const depositWalletAddress = computeDepositWalletAddress(eoaAddress);

  console.log(`EOA:            ${eoaAddress}`);
  console.log(`Deposit wallet: ${depositWalletAddress}`);
  console.log(`Recipient:      ${RECIPIENT}`);
  console.log(`Amount:         ${AMOUNT_USDCE} (17 USDC.e)`);

  // Check current balance
  const usdce = new Interface([
    "function balanceOf(address) view returns (uint256)",
  ]);
  const balResult = await provider.call({
    to: USDCE_ADDRESS,
    data: usdce.encodeFunctionData("balanceOf", [depositWalletAddress]),
  });
  const balance = BigInt(balResult);
  console.log(
    `Deposit wallet USDC.e balance: ${balance} (${Number(balance) / 1e6} USDC.e)`,
  );

  if (balance < AMOUNT_USDCE) {
    throw new Error(
      `Insufficient balance: have ${balance}, need ${AMOUNT_USDCE}`,
    );
  }

  // Build transfer calldata
  const transferCalldata = ERC20_IFACE.encodeFunctionData("transfer", [
    RECIPIENT,
    AMOUNT_USDCE,
  ]);
  const calls = [{ target: USDCE_ADDRESS, value: "0", data: transferCalldata }];

  console.log(`\nDeriving CLOB API key...`);
  const clobCreds = await deriveOrCreateClobApiKey(wallet);
  const builderCreds = await getOrCreateBuilderApiKey(wallet, clobCreds);

  const nonceResp = await relayerGet("/nonce", {
    address: eoaAddress,
    type: "WALLET",
  });
  const nonce = String(nonceResp["nonce"] ?? "0");
  const deadline = String(Math.floor(Date.now() / 1000) + 3600);

  const domain = {
    name: "DepositWallet",
    version: "1",
    chainId: 137,
    verifyingContract: depositWalletAddress,
  };
  const types = {
    Call: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    Batch: [
      { name: "wallet", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "calls", type: "Call[]" },
    ],
  };
  const message = {
    wallet: depositWalletAddress,
    nonce: BigInt(nonce),
    deadline: BigInt(deadline),
    calls: calls.map((c) => ({ target: c.target, value: 0n, data: c.data })),
  };

  console.log(`Signing EIP-712 batch (nonce=${nonce})...`);
  const signature = await wallet.signTypedData(domain, types, message);

  console.log(`Submitting to gasless relayer...`);
  const batchResp = await relayerPost(
    "/submit",
    {
      type: "WALLET",
      from: eoaAddress,
      to: DEPOSIT_WALLET_FACTORY,
      nonce,
      signature,
      depositWalletParams: {
        depositWallet: depositWalletAddress,
        deadline,
        calls,
      },
    },
    builderCreds,
  );

  const txId = String(batchResp["transactionID"] ?? "");
  if (!txId)
    throw new Error(`No transactionID returned: ${JSON.stringify(batchResp)}`);
  console.log(`Submitted! txID=${txId}  Polling...`);

  const txHash = await pollRelayerTx(txId);
  console.log(`\n✅ Done! 17 USDC.e sent to ${RECIPIENT}`);
  console.log(`   TX: https://polygonscan.com/tx/${txHash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
