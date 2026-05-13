/**
 * routes/redeem.ts
 *
 * POST /redeem
 *
 * Redeems resolved ERC-1155 conditional token positions back to pUSD.
 * Uses the Polymarket gasless relayer (EIP-712 WALLET batch) — no POL needed.
 *
 * Body:
 *   {
 *     index:        number   — HD wallet index of the bot EOA (>= 10)
 *     conditionId:  string   — bytes32 hex (from Polymarket positions API)
 *     outcomeIndex: number   — 0 = first outcome (YES), 1 = second (NO), etc.
 *     negativeRisk: boolean  — (reserved, currently always uses CTF_CONTRACT_ADDRESS)
 *   }
 *
 * Response:
 *   { txHash: string, depositWallet: string, conditionId: string, outcomeIndex: number }
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  JsonRpcProvider,
  Contract,
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

const PUSD_TOKEN_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDCE_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_CONTRACT_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

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

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
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

// ── Auth & relayer helpers (mirrors deposit-polymarket.ts) ────────────────────

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
        `[redeem] Relayer txID=${transactionId} confirmed hash=${hash}`,
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
      `[redeem] Relayer txID=${transactionId} state=${state} hash=${hash} (poll ${i + 1}/${maxPolls})`,
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
    const { index, conditionId, outcomeIndex, negativeRisk, tokenId } =
      req.body as {
        index?: unknown;
        conditionId?: unknown;
        outcomeIndex?: unknown;
        negativeRisk?: unknown;
        tokenId?: unknown;
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

    console.log(
      `[redeem] index=${index} eoa=${eoaAddress} depositWallet=${depositWalletAddress}`,
    );

    // ── Build CTF redeemPositions calldata ────────────────────────────────────

    // indexSets: bit N set = redeem outcome N. outcomeIndex 0 → 1, 1 → 2, 2 → 4 …
    const indexSets = [BigInt(1) << BigInt(outcomeIndex)];
    const parentCollectionId = zeroPadValue("0x00", 32); // bytes32(0)

    // Detect which collateral token the position was created with.
    // Polymarket uses pUSD for new markets and USDC.e for older markets.
    // We determine this by asking the CTF contract which collateral token
    // produces a positionId matching the known tokenId.
    const ctfReader = new Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, provider);
    let collateralToken = PUSD_TOKEN_ADDRESS; // default
    if (typeof tokenId === "string" && tokenId.length > 0) {
      const knownTokenId = BigInt(tokenId);
      const collectionId = await (
        ctfReader.getCollectionId as (
          p: string,
          c: string,
          i: bigint,
        ) => Promise<string>
      )(parentCollectionId, conditionId, indexSets[0]);
      const pusdPosId = await (
        ctfReader.getPositionId as (
          col: string,
          colId: string,
        ) => Promise<bigint>
      )(PUSD_TOKEN_ADDRESS, collectionId);
      const usdcePosId = await (
        ctfReader.getPositionId as (
          col: string,
          colId: string,
        ) => Promise<bigint>
      )(USDCE_TOKEN_ADDRESS, collectionId);
      if (usdcePosId === knownTokenId) {
        collateralToken = USDCE_TOKEN_ADDRESS;
        console.log(`[redeem] Detected collateral: USDC.e`);
      } else if (pusdPosId === knownTokenId) {
        collateralToken = PUSD_TOKEN_ADDRESS;
        console.log(`[redeem] Detected collateral: pUSD`);
      } else {
        console.warn(
          `[redeem] tokenId ${tokenId} did not match pUSD or USDC.e for indexSet=${indexSets[0]} — defaulting to pUSD`,
        );
      }
    } else {
      console.warn(
        `[redeem] No tokenId provided — defaulting collateral to pUSD`,
      );
    }

    const ctfInterface = new Interface(CTF_ABI);
    const redeemCalldata = ctfInterface.encodeFunctionData("redeemPositions", [
      collateralToken,
      parentCollectionId,
      conditionId,
      indexSets,
    ]);

    // ── Submit via Polymarket gasless relayer (no POL needed) ─────────────────

    const calls = [
      { target: CTF_CONTRACT_ADDRESS, value: "0", data: redeemCalldata },
    ];

    console.log(`[redeem] Deriving CLOB API key for ${eoaAddress}...`);
    const clobCreds = await deriveOrCreateClobApiKey(wallet);
    const builderCreds = await getOrCreateBuilderApiKey(wallet, clobCreds);

    // Get next nonce for WALLET-type batches
    const nonceResp = await relayerGet("/nonce", {
      address: eoaAddress,
      type: "WALLET",
    });
    const nonce = String(nonceResp["nonce"] ?? "0");
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);

    // EIP-712 batch signature (DepositWallet domain)
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

    console.log(`[redeem] Signing EIP-712 batch (nonce=${nonce})...`);
    const signature = await wallet.signTypedData(domain, types, message);

    console.log(`[redeem] Submitting WALLET batch to relayer...`);
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
      `[redeem] WALLET batch submitted txID=${batchTxId}, polling...`,
    );
    const txHash = await pollRelayerTx(batchTxId);

    return res.json({
      txHash,
      depositWallet: depositWalletAddress,
      conditionId,
      outcomeIndex,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
