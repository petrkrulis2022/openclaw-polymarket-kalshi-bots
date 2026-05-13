/**
 * routes/withdraw-deposit.ts
 *
 * POST /withdraw-deposit
 *
 * Transfers USDC.e from a user's Polymarket deposit wallet (CREATE2) to an
 * external address via the Polymarket gasless relayer — no POL needed.
 *
 * The deposit wallet is the ERC-1967 proxy deployed at the CREATE2 address
 * derived from the bot EOA.  It can only be controlled via the gasless
 * relayer using an EIP-712 WALLET-type signed batch.
 *
 * Body:
 *   {
 *     index:       number   — HD wallet index (must be >= 10)
 *     toAddress:   string   — recipient Ethereum address (0x…)
 *     amountUsdce?: string  — optional; omit or pass "0" to send full balance
 *   }
 *
 * Response:
 *   { txHash: string, from: string, to: string, amount: string }
 *   amount is the human-readable USDC.e transferred (e.g. "55.00")
 */

import { Router, Request, Response, NextFunction } from "express";
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
import { createHmac } from "crypto";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

// ── Contract addresses (Polygon mainnet) ─────────────────────────────────────

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

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// ── Deposit wallet address derivation (mirrors redeem.ts) ─────────────────────

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
  const abiCoder = AbiCoder.defaultAbiCoder();
  const walletId = zeroPadValue(eoaAddress, 32);
  const args = abiCoder.encode(
    ["address", "bytes32"],
    [DEPOSIT_WALLET_FACTORY, walletId],
  );
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967(DEPOSIT_WALLET_IMPL, args);
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, bytecodeHash);
}

// ── Auth & relayer helpers (mirrors redeem.ts) ────────────────────────────────

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

function buildHmacSig(
  secret: string,
  ts: number,
  method: string,
  path: string,
  body?: string,
): string {
  let message = `${ts}${method}${path}`;
  if (body !== undefined) message += body;
  const hmac = createHmac("sha256", Buffer.from(secret, "base64"));
  const sig = hmac.update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

async function clobL1Headers(
  wallet: HDNodeWallet,
): Promise<Record<string, string>> {
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

function clobL2Headers(
  address: string,
  creds: ApiCreds,
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
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

async function deriveOrCreateClobApiKey(
  wallet: HDNodeWallet,
): Promise<ApiCreds> {
  const l1 = await clobL1Headers(wallet);
  const headers = { "Content-Type": "application/json", ...l1 };
  const deriveResp = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    headers,
  });
  if (deriveResp.ok) {
    const body = (await deriveResp.json()) as Record<string, string>;
    const key = body["apiKey"] ?? body["key"];
    const secret = body["secret"] ?? body["api_secret"];
    if (key && secret)
      return { key, secret, passphrase: body["passphrase"] ?? "" };
  }
  const createResp = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: "POST",
    headers,
  });
  const createBody = (await createResp.json()) as Record<string, string>;
  const createdKey = createBody["apiKey"] ?? createBody["key"];
  const createdSecret = createBody["secret"] ?? createBody["api_secret"];
  if (!createResp.ok || !createdKey || !createdSecret) {
    throw new Error(
      `CLOB createApiKey failed (${createResp.status}): ${JSON.stringify(createBody)}`,
    );
  }
  return {
    key: createdKey,
    secret: createdSecret,
    passphrase: createBody["passphrase"] ?? "",
  };
}

async function getOrCreateBuilderApiKey(
  wallet: HDNodeWallet,
  clobCreds: ApiCreds,
): Promise<ApiCreds> {
  const path = "/auth/builder-api-key";
  const eoa = wallet.address;
  const getHeaders = {
    "Content-Type": "application/json",
    ...clobL2Headers(eoa, clobCreds, "GET", path),
  };
  const getResp = await fetch(`${CLOB_HOST}${path}`, { headers: getHeaders });
  if (getResp.ok) {
    const body = (await getResp.json()) as unknown;
    const first = Array.isArray(body)
      ? (body[0] as Record<string, string>)
      : (body as Record<string, string>);
    const existingKey = first?.["apiKey"] ?? first?.["key"];
    const existingSecret = first?.["secret"] ?? first?.["api_secret"];
    if (existingKey && existingSecret) {
      return {
        key: existingKey,
        secret: existingSecret,
        passphrase: first["passphrase"] ?? "",
      };
    }
  }
  const postHeaders = {
    "Content-Type": "application/json",
    ...clobL2Headers(eoa, clobCreds, "POST", path),
  };
  const postResp = await fetch(`${CLOB_HOST}${path}`, {
    method: "POST",
    headers: postHeaders,
  });
  const postBody = (await postResp.json()) as Record<string, string>;
  const createdKey = postBody["apiKey"] ?? postBody["key"];
  const createdSecret = postBody["secret"] ?? postBody["api_secret"];
  if (!postResp.ok || !createdKey || !createdSecret) {
    throw new Error(
      `Builder createApiKey failed (${postResp.status}): ${JSON.stringify(postBody)}`,
    );
  }
  return {
    key: createdKey,
    secret: createdSecret,
    passphrase: postBody["passphrase"] ?? "",
  };
}

async function relayerGet(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${RELAYER_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  const body = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(
      `Relayer GET ${path} failed (${resp.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function relayerPost(
  path: string,
  payload: unknown,
  builderCreds?: ApiCreds,
): Promise<Record<string, unknown>> {
  const bodyStr = JSON.stringify(payload);
  const extraHeaders: Record<string, string> = {};
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
  const body = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(
      `Relayer POST ${path} failed (${resp.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function pollRelayerTx(
  transactionId: string,
  maxPolls = 120,
  intervalMs = 5000,
): Promise<string> {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let result: Record<string, unknown>;
    try {
      result = await relayerGet("/transaction", { id: transactionId });
    } catch {
      continue;
    }
    const txns = Array.isArray(result) ? result : [result];
    const txn = txns[0] as Record<string, unknown> | undefined;
    if (!txn) continue;
    const state = String(txn["state"] ?? txn["status"] ?? "");
    const hash = String(
      txn["transactionHash"] ?? txn["hash"] ?? txn["txHash"] ?? "",
    );
    if (
      state === "CONFIRMED" ||
      state === "STATE_CONFIRMED" ||
      state === "MINED" ||
      state === "SUCCESS" ||
      state === "confirmed" ||
      state === "mined" ||
      state === "success" ||
      (state === "" && hash.length > 10)
    ) {
      console.log(
        `[withdraw-deposit] Relayer txID=${transactionId} confirmed hash=${hash}`,
      );
      return hash;
    }
    if (
      state.toUpperCase().includes("FAIL") ||
      state === "REVERTED" ||
      state === "reverted"
    ) {
      throw new Error(
        `Relayer transaction ${transactionId} failed with state: ${state}`,
      );
    }
    console.log(
      `[withdraw-deposit] Relayer txID=${transactionId} state=${state} (poll ${i + 1}/${maxPolls})`,
    );
  }
  throw new Error(
    `Relayer transaction ${transactionId} timed out after ${maxPolls} polls`,
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, toAddress, amountUsdce } = req.body as {
      index?: unknown;
      toAddress?: unknown;
      amountUsdce?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error: "index must be an integer >= 10",
      });
    }

    if (
      typeof toAddress !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(toAddress)
    ) {
      return res.status(400).json({
        error: "toAddress must be a valid Ethereum address (0x…)",
      });
    }

    // ── Derive wallets ────────────────────────────────────────────────────────

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const eoaAddress = wallet.address;
    const depositWalletAddress = computeDepositWalletAddress(eoaAddress);

    console.log(
      `[withdraw-deposit] index=${index} eoa=${eoaAddress} depositWallet=${depositWalletAddress}`,
    );

    // ── Check USDC.e balance in deposit wallet ────────────────────────────────

    const erc20If = new Interface(ERC20_ABI);
    const balCalldata = erc20If.encodeFunctionData("balanceOf", [
      depositWalletAddress,
    ]);
    const balResult = await provider.call({
      to: USDCE_ADDRESS,
      data: balCalldata,
    });
    const balance = BigInt(balResult);

    if (balance === 0n) {
      return res.status(400).json({
        error: "No USDC.e balance in deposit wallet",
        depositWallet: depositWalletAddress,
      });
    }

    // ── Resolve amount ────────────────────────────────────────────────────────

    let amount: bigint;
    if (
      amountUsdce !== undefined &&
      amountUsdce !== null &&
      amountUsdce !== "" &&
      amountUsdce !== "0"
    ) {
      // Expect a human-readable string like "17" or "17.5" (or raw int string)
      const parsed = parseFloat(String(amountUsdce));
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ error: "Invalid amountUsdce" });
      }
      amount = BigInt(Math.round(parsed * 1_000_000));
      if (amount > balance) {
        return res.status(400).json({
          error: `Insufficient balance: have ${(Number(balance) / 1e6).toFixed(2)}, need ${parsed.toFixed(2)}`,
        });
      }
    } else {
      amount = balance;
    }

    console.log(
      `[withdraw-deposit] Sending ${(Number(amount) / 1e6).toFixed(2)} USDC.e → ${toAddress}`,
    );

    // ── Build ERC20 transfer calldata ─────────────────────────────────────────

    const transferCalldata = erc20If.encodeFunctionData("transfer", [
      toAddress,
      amount,
    ]);

    const calls = [
      { target: USDCE_ADDRESS, value: "0", data: transferCalldata },
    ];

    // ── Get CLOB / builder API keys ───────────────────────────────────────────

    console.log(
      `[withdraw-deposit] Deriving CLOB API key for ${eoaAddress}...`,
    );
    const clobCreds = await deriveOrCreateClobApiKey(wallet);
    const builderCreds = await getOrCreateBuilderApiKey(wallet, clobCreds);

    // ── Get relayer nonce ─────────────────────────────────────────────────────

    const nonceResp = await relayerGet("/nonce", {
      address: eoaAddress,
      type: "WALLET",
    });
    const nonce = String(nonceResp["nonce"] ?? "0");
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);

    // ── Sign EIP-712 WALLET batch ─────────────────────────────────────────────

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

    console.log(
      `[withdraw-deposit] Signing EIP-712 batch (nonce=${nonce})...`,
    );
    const signature = await wallet.signTypedData(domain, types, message);

    // ── Submit to relayer ─────────────────────────────────────────────────────

    console.log(`[withdraw-deposit] Submitting WALLET batch to relayer...`);
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

    const batchTxId = String(batchResp["transactionID"] ?? "");
    if (!batchTxId) {
      throw new Error(
        `WALLET batch did not return a transactionID: ${JSON.stringify(batchResp)}`,
      );
    }

    console.log(
      `[withdraw-deposit] WALLET batch submitted txID=${batchTxId}, polling...`,
    );
    const txHash = await pollRelayerTx(batchTxId);

    const amountFormatted = (Number(amount) / 1e6).toFixed(2);
    return res.json({
      txHash,
      from: depositWalletAddress,
      to: toAddress,
      amount: amountFormatted,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
