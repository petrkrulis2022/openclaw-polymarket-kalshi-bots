/**
 * routes/deposit-polymarket.ts
 *
 * GET  /deposit-polymarket/address?index=N
 *   Returns the deterministic deposit wallet address for the given HD index.
 *
 * POST /deposit-polymarket
 *   Full deposit wallet setup for Polymarket V2 (POLY_1271 mode).
 *
 * Polymarket V2 requires a Deposit Wallet (ERC-1967 proxy) per user.
 * Pure EOA (POLY_EOA) is NOT allowed for new accounts on the CLOB.
 *
 * Flow:
 *   1. Derive EOA from HD wallet index
 *   2. Compute deposit wallet address (deterministic CREATE2 formula)
 *   3. Deploy deposit wallet via Polymarket relayer (WALLET-CREATE, gasless)
 *   4. Wrap USDC.e → pUSD via CollateralOnramp (direct on-chain, if USDC.e present)
 *   5. Transfer pUSD from EOA to deposit wallet (direct on-chain ERC-20 transfer)
 *   6. Execute approval batch FROM deposit wallet via relayer (WALLET type, EIP-712 signed):
 *        - pUSD.approve(CTF_CONTRACT, MaxUint256)
 *        - CTF.setApprovalForAll(CTF_EXCHANGE, true)
 *        - CTF.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true)
 *   7. Return deposit wallet address and status
 *
 * Bots must be configured with:
 *   POLYMARKET_WALLET_ADDRESS  = depositWalletAddress
 *   POLYMARKET_FUNDER_ADDRESS  = depositWalletAddress
 *   POLYMARKET_SIGNATURE_TYPE  = POLY_1271
 *   BOT_SIGNER_KEY             = EOA private key (unchanged)
 *
 * Internal-only endpoint — not exposed via public proxy.
 */

import { createHmac } from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import {
  JsonRpcProvider,
  HDNodeWallet,
  Mnemonic,
  Contract,
  Interface,
  MaxUint256,
  keccak256,
  AbiCoder,
  concat,
  getCreate2Address,
  zeroPadValue,
  toBeHex,
} from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

// ── Contract addresses (Polygon mainnet) ─────────────────────────────────────

const USDCE_TOKEN_ADDRESS   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD_TOKEN_ADDRESS    = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const COLLATERAL_ONRAMP     = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const CTF_CONTRACT_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_EXCHANGE_ADDRESS  = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_CTF_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";

// Deposit wallet contracts (Polygon mainnet)
// Factory: deterministic CREATE2 deployer for per-user ERC-1967 proxies
// Source: @polymarket/builder-relayer-client src/config/index.ts
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPL    = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

// Polymarket relayer
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// CLOB API for deriving API keys used by the relayer
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const CLOB_MSG_TO_SIGN = "This message attests that I control the given wallet";

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const ONRAMP_ABI = [
  "function wrap(address _asset, address _to, uint256 _amount) external",
];

const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

// ── Deposit wallet address derivation ────────────────────────────────────────
// Mirrors @polymarket/builder-relayer-client src/builder/derive.ts
// Uses Solady LibClone.initCodeHashERC1967 formula.

const ERC1967_CONST1 =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

function initCodeHashERC1967(implementation: string, args: string): string {
  // args is "0x..." hex string; compute byte length
  const n = BigInt((args.length - 2) / 2);
  // Embed args length into the prefix (adds n to byte 2 of the 10-byte prefix)
  const combined = ERC1967_PREFIX + (n << 56n);
  return keccak256(
    concat([
      toBeHex(combined, 10), // 10-byte init code prefix
      implementation,        // 20-byte implementation address
      "0x6009",              // 2-byte constant
      ERC1967_CONST2,        // 32-byte constant
      ERC1967_CONST1,        // 32-byte constant
      args,                  // n-byte ABI-encoded constructor args
    ]),
  );
}

function computeDepositWalletAddress(owner: string): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  // walletId = bytes32(owner): 20-byte address left-padded to 32 bytes
  const walletId = zeroPadValue(owner, 32);
  // args = abi.encode(address factory, bytes32 walletId)
  const args = abiCoder.encode(
    ["address", "bytes32"],
    [DEPOSIT_WALLET_FACTORY, walletId],
  );
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967(DEPOSIT_WALLET_IMPL, args);
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, bytecodeHash);
}

// ── Auth helpers (CLOB API key → Builder API key → relayer HMAC) ─────────────

/** HMAC-SHA256 with URL-safe base64 output (same algo used by CLOB and builder-signing-sdk). */
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

/**
 * Build CLOB L1 auth headers by signing an EIP-712 ClobAuth message with the EOA wallet.
 * Used to derive/create CLOB API keys.
 */
async function clobL1Headers(wallet: HDNodeWallet): Promise<Record<string, string>> {
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

/**
 * Build CLOB L2 auth headers using HMAC with existing API credentials.
 * Used for authenticated CLOB API calls (e.g. creating a builder API key).
 */
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

/**
 * Derive (or create) a CLOB API key for the given EOA wallet.
 * Try /auth/derive-api-key first (deterministic); fall back to /auth/api-key.
 */
async function deriveOrCreateClobApiKey(wallet: HDNodeWallet): Promise<ApiCreds> {
  const l1 = await clobL1Headers(wallet);
  const headers = { "Content-Type": "application/json", ...l1 };

  // Try derive first (returns existing key deterministically)
  const deriveResp = await fetch(`${CLOB_HOST}/auth/derive-api-key`, { headers });
  if (deriveResp.ok) {
    const body = (await deriveResp.json()) as Record<string, string>;
    if (body["apiKey"]) {
      return { key: body["apiKey"], secret: body["secret"]!, passphrase: body["passphrase"]! };
    }
  }

  // Fall back to create
  const createResp = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "POST", headers });
  const createBody = (await createResp.json()) as Record<string, string>;
  if (!createResp.ok || !createBody["apiKey"]) {
    throw new Error(`CLOB createApiKey failed (${createResp.status}): ${JSON.stringify(createBody)}`);
  }
  return { key: createBody["apiKey"], secret: createBody["secret"]!, passphrase: createBody["passphrase"]! };
}

/**
 * Get or create a Builder API key for use with the Polymarket relayer.
 * Requires a valid CLOB API key (L2 auth).
 */
async function getOrCreateBuilderApiKey(
  wallet: HDNodeWallet,
  clobCreds: ApiCreds,
): Promise<ApiCreds> {
  const path = "/auth/builder-api-key";
  const eoa = wallet.address;

  // Try GET first (returns existing builder key)
  const getHeaders = {
    "Content-Type": "application/json",
    ...clobL2Headers(eoa, clobCreds, "GET", path),
  };
  const getResp = await fetch(`${CLOB_HOST}${path}`, { headers: getHeaders });
  if (getResp.ok) {
    const body = (await getResp.json()) as unknown;
    const first = Array.isArray(body) ? (body[0] as Record<string, string>) : (body as Record<string, string>);
    if (first?.["apiKey"]) {
      return { key: first["apiKey"], secret: first["secret"]!, passphrase: first["passphrase"]! };
    }
  }

  // Create new builder API key
  const postHeaders = {
    "Content-Type": "application/json",
    ...clobL2Headers(eoa, clobCreds, "POST", path),
  };
  const postResp = await fetch(`${CLOB_HOST}${path}`, { method: "POST", headers: postHeaders });
  const postBody = (await postResp.json()) as Record<string, string>;
  if (!postResp.ok || !postBody["apiKey"]) {
    throw new Error(`Builder createApiKey failed (${postResp.status}): ${JSON.stringify(postBody)}`);
  }
  return { key: postBody["apiKey"], secret: postBody["secret"]!, passphrase: postBody["passphrase"]! };
}

// ── Relayer HTTP helpers ──────────────────────────────────────────────────────

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

/** Poll relayer until transaction reaches a terminal state. Returns tx hash. */
async function pollRelayerTx(
  transactionId: string,
  maxPolls = 40,
  intervalMs = 3000,
): Promise<string> {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await relayerGet("/transaction", { id: transactionId });
    const txns = Array.isArray(result) ? result : [result];
    const txn = txns[0] as Record<string, unknown> | undefined;
    if (!txn) continue;
    const state = String(txn["state"] ?? "");
    const hash  = String(txn["transactionHash"] ?? "");
    if (
      state === "CONFIRMED" ||
      state === "MINED" ||
      state === "SUCCESS" ||
      (state === "" && hash.length > 2)
    ) {
      return hash;
    }
    if (state.toUpperCase().includes("FAIL") || state === "REVERTED") {
      throw new Error(
        `Relayer transaction ${transactionId} failed with state: ${state}`,
      );
    }
    console.log(`[deposit-polymarket] Relayer txID=${transactionId} state=${state} (poll ${i + 1}/${maxPolls})`);
  }
  throw new Error(
    `Relayer transaction ${transactionId} timed out after ${maxPolls} polls`,
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// GET /deposit-polymarket/address?index=N
// Returns the deterministic deposit wallet address for the given HD index.
// Does NOT deploy anything — pure address computation.
router.get(
  "/address",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const index = parseInt(String(req.query["index"] ?? ""), 10);
      if (isNaN(index) || index < 10) {
        return res
          .status(400)
          .json({ error: "index must be an integer >= 10" });
      }
      const hdWallet = HDNodeWallet.fromMnemonic(
        Mnemonic.fromPhrase(SEED_PHRASE),
        `m/44'/60'/0'/0/${index}`,
      );
      const eoa = hdWallet.address;
      const depositWalletAddress = computeDepositWalletAddress(eoa);
      return res.json({ depositWalletAddress, eoa, index });
    } catch (err) {
      return next(err);
    }
  },
);

// POST /deposit-polymarket
// Full idempotent setup: deploy deposit wallet + fund + set approvals.
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, amountUsdce } = req.body as {
      index?: unknown;
      amountUsdce?: unknown;
    };

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const eoa = wallet.address;
    const depositWalletAddress = computeDepositWalletAddress(eoa);

    console.log(
      `[deposit-polymarket] index=${index} eoa=${eoa} depositWallet=${depositWalletAddress}`,
    );

    // ── Step 1: Deploy deposit wallet (if not already deployed) ───────────────
    // Derive CLOB + Builder API keys (needed to authenticate with the relayer)
    console.log(`[deposit-polymarket] Deriving CLOB API key for ${eoa}...`);
    const clobCreds = await deriveOrCreateClobApiKey(wallet);
    console.log(`[deposit-polymarket] Getting Builder API key...`);
    const builderCreds = await getOrCreateBuilderApiKey(wallet, clobCreds);

    const deployedResp = await relayerGet("/deployed", {
      address: depositWalletAddress,
      type: "WALLET",
    });
    let isDeployed = deployedResp["deployed"] === true;
    let deployTxHash: string | null = null;

    if (!isDeployed) {
      console.log(
        `[deposit-polymarket] Deploying deposit wallet via relayer...`,
      );
      const createResp = await relayerPost("/submit", {
        type: "WALLET-CREATE",
        from: eoa,
        to: DEPOSIT_WALLET_FACTORY,
      }, builderCreds);
      const deployTxId = String(createResp["transactionID"] ?? "");
      if (!deployTxId) {
        throw new Error(
          `WALLET-CREATE did not return a transactionID: ${JSON.stringify(createResp)}`,
        );
      }
      console.log(
        `[deposit-polymarket] WALLET-CREATE submitted txID=${deployTxId}, polling...`,
      );
      deployTxHash = await pollRelayerTx(deployTxId);
      isDeployed = true;
      console.log(
        `[deposit-polymarket] Deposit wallet deployed txHash=${deployTxHash}`,
      );
    } else {
      console.log(
        `[deposit-polymarket] Deposit wallet already deployed: ${depositWalletAddress}`,
      );
    }

    // ── Step 2: Wrap USDC.e → pUSD (if EOA has USDC.e) ───────────────────────
    const usdce = new Contract(USDCE_TOKEN_ADDRESS, ERC20_ABI, wallet);
    const onramp = new Contract(COLLATERAL_ONRAMP, ONRAMP_ABI, wallet);

    const [usdceBalance, nativeBalance] = await Promise.all([
      usdce.balanceOf(eoa) as Promise<bigint>,
      provider.getBalance(eoa),
    ]);

    if (usdceBalance > 0n) {
      if (nativeBalance === 0n) {
        return res.status(400).json({
          error: "No gas",
          message: "EOA has USDC.e but no POL for gas to wrap it to pUSD.",
        });
      }
      let wrapAmount = usdceBalance;
      if (
        amountUsdce !== undefined &&
        amountUsdce !== "" &&
        amountUsdce !== null
      ) {
        wrapAmount = BigInt(
          Math.round(parseFloat(String(amountUsdce)) * 1_000_000),
        );
        if (wrapAmount <= 0n || wrapAmount > usdceBalance) {
          return res
            .status(400)
            .json({ error: "Invalid amountUsdce", usdceBalance: String(usdceBalance) });
        }
      }
      console.log(
        `[deposit-polymarket] Wrapping ${wrapAmount} USDC.e → pUSD...`,
      );
      const approveTx = await usdce.approve(COLLATERAL_ONRAMP, wrapAmount);
      await approveTx.wait(1);
      const wrapTx = await onramp.wrap(USDCE_TOKEN_ADDRESS, eoa, wrapAmount);
      await wrapTx.wait(1);
      console.log(`[deposit-polymarket] USDC.e → pUSD wrap complete`);
    }

    // ── Step 3: Transfer pUSD from EOA to deposit wallet ──────────────────────
    const pusd = new Contract(PUSD_TOKEN_ADDRESS, ERC20_ABI, wallet);
    const pusdBalanceEoa = (await pusd.balanceOf(eoa)) as bigint;
    let pUsdTransferTxHash: string | null = null;

    if (pusdBalanceEoa > 0n) {
      // Re-check native balance (it may have dropped after the wrap)
      const polBalance = await provider.getBalance(eoa);
      if (polBalance === 0n) {
        return res.status(400).json({
          error: "No gas",
          message:
            "EOA has pUSD but no POL for gas to transfer it to the deposit wallet.",
        });
      }
      console.log(
        `[deposit-polymarket] Transferring ${pusdBalanceEoa} pUSD to deposit wallet...`,
      );
      const transferTx = await pusd.transfer(depositWalletAddress, pusdBalanceEoa);
      const receipt = await transferTx.wait(1);
      pUsdTransferTxHash =
        (receipt as { hash?: string } | null)?.hash ?? transferTx.hash;
      console.log(
        `[deposit-polymarket] pUSD transferred txHash=${pUsdTransferTxHash}`,
      );
    }

    // ── Step 4: Set approvals FROM deposit wallet via relayer batch ───────────
    // Check current approval state (deposit wallet is now deployed)
    const pusdRo = new Contract(PUSD_TOKEN_ADDRESS, ERC20_ABI, provider);
    const ctfRo  = new Contract(CTF_CONTRACT_ADDRESS, ERC1155_ABI, provider);

    const [pUsdAllowance, ctfApprovedExchange, ctfApprovedNegRisk] =
      await Promise.all([
        pusdRo.allowance(depositWalletAddress, CTF_CONTRACT_ADDRESS) as Promise<bigint>,
        ctfRo.isApprovedForAll(depositWalletAddress, CTF_EXCHANGE_ADDRESS) as Promise<boolean>,
        ctfRo.isApprovedForAll(depositWalletAddress, NEG_RISK_CTF_EXCHANGE) as Promise<boolean>,
      ]);

    const erc20Iface   = new Interface(["function approve(address,uint256) returns (bool)"]);
    const erc1155Iface = new Interface(["function setApprovalForAll(address,bool)"]);

    const calls: Array<{ target: string; value: string; data: string }> = [];

    if (pUsdAllowance < MaxUint256) {
      calls.push({
        target: PUSD_TOKEN_ADDRESS,
        value: "0",
        data: erc20Iface.encodeFunctionData("approve", [
          CTF_CONTRACT_ADDRESS,
          MaxUint256,
        ]),
      });
    }
    if (!ctfApprovedExchange) {
      calls.push({
        target: CTF_CONTRACT_ADDRESS,
        value: "0",
        data: erc1155Iface.encodeFunctionData("setApprovalForAll", [
          CTF_EXCHANGE_ADDRESS,
          true,
        ]),
      });
    }
    if (!ctfApprovedNegRisk) {
      calls.push({
        target: CTF_CONTRACT_ADDRESS,
        value: "0",
        data: erc1155Iface.encodeFunctionData("setApprovalForAll", [
          NEG_RISK_CTF_EXCHANGE,
          true,
        ]),
      });
    }

    let approvalTxHash: string | null = null;

    if (calls.length > 0) {
      // Get next nonce for this EOA's WALLET-type batches
      const nonceResp = await relayerGet("/nonce", {
        address: eoa,
        type: "WALLET",
      });
      const nonce = String(nonceResp["nonce"] ?? "0");
      // Deadline: 1 hour from now (Unix seconds as string)
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
          { name: "data",   type: "bytes"    },
        ],
        Batch: [
          { name: "wallet",   type: "address"  },
          { name: "nonce",    type: "uint256"  },
          { name: "deadline", type: "uint256"  },
          { name: "calls",    type: "Call[]"   },
        ],
      };
      const message = {
        wallet:   depositWalletAddress,
        nonce:    BigInt(nonce),
        deadline: BigInt(deadline),
        calls: calls.map((c) => ({
          target: c.target,
          value:  0n,
          data:   c.data,
        })),
      };

      console.log(
        `[deposit-polymarket] Signing EIP-712 batch (${calls.length} calls, nonce=${nonce})...`,
      );
      const signature = await wallet.signTypedData(domain, types, message);

      console.log(`[deposit-polymarket] Submitting WALLET batch to relayer...`);
      const batchResp = await relayerPost("/submit", {
        type: "WALLET",
        from: eoa,
        to: DEPOSIT_WALLET_FACTORY,
        nonce,
        signature,
        depositWalletParams: {
          depositWallet: depositWalletAddress,
          deadline,
          calls,
        },
      }, builderCreds);

      const batchTxId = String(batchResp["transactionID"] ?? "");
      if (!batchTxId) {
        throw new Error(
          `WALLET batch did not return a transactionID: ${JSON.stringify(batchResp)}`,
        );
      }
      console.log(
        `[deposit-polymarket] WALLET batch submitted txID=${batchTxId}, polling...`,
      );
      approvalTxHash = await pollRelayerTx(batchTxId);
      console.log(
        `[deposit-polymarket] Approvals set txHash=${approvalTxHash}`,
      );
    } else {
      console.log(
        `[deposit-polymarket] All approvals already set on deposit wallet — skipping batch`,
      );
    }

    // Final pUSD balance on the deposit wallet
    const finalPusdBalance = (await pusdRo.balanceOf(
      depositWalletAddress,
    )) as bigint;

    return res.json({
      depositWalletAddress,
      eoa,
      isDeployed,
      deployTxHash,
      pUsdTransferTxHash,
      approvalTxHash,
      depositWalletPusdBalance: (
        Number(finalPusdBalance) / 1_000_000
      ).toFixed(6),
      note: "Deposit wallet setup complete. Configure bots with POLY_1271, POLYMARKET_WALLET_ADDRESS=depositWalletAddress, POLYMARKET_FUNDER_ADDRESS=depositWalletAddress.",
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
