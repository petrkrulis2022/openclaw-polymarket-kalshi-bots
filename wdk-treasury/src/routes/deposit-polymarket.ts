/**
 * routes/deposit-polymarket.ts
 *
 * POST /deposit-polymarket
 *
 * Sets up a user bot wallet (index >= 10) to trade on Polymarket V2 (POLY_EOA mode).
 *
 * Polymarket V2 (live April 28 2026) uses pUSD as collateral and a new Exchange.
 * There is NO Exchange.deposit() in V2. Instead the Exchange reads the EOA's CTF
 * token balances directly and pulls them at fill time.
 *
 * Flow:
 *   1. USDC.e.approve(CollateralOnramp, amount)
 *   2. CollateralOnramp.wrap(USDC.e, EOA, amount)   → mints pUSD to EOA
 *   3. pUSD.approve(CTF_CONTRACT, MaxUint256)        → allows CTF to split pUSD→tokens
 *   4. CTF.setApprovalForAll(CTF_EXCHANGE, true)     → allows Exchange to move tokens
 *   5. CTF.setApprovalForAll(NEG_RISK_EXCHANGE, true)→ same for neg-risk markets
 *
 * After setup, the CLOB client calls updateBalanceAllowance() on next startup to
 * sync the on-chain balance with the CLOB backend.
 *
 * Uses ethers.js directly (bypassing WDK signing) to avoid WDK memory-safe
 * key disposal issues that cause "Uint8Array expected" errors.
 *
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number, proxyWalletAddress?: string, amountUsdce?: string }
 *           index               — HD wallet index (must be >= 10)
 *           proxyWalletAddress  — (legacy, ignored) was the Gnosis Safe address
 *           amountUsdce         — optional; omit to wrap the full USDC.e balance
 *
 * Response: { from, pUsdBalance, pUsdApprovedToCtf, ctfApprovedToExchange, ... }
 */

import { Router, Request, Response, NextFunction } from "express";
import { JsonRpcProvider, HDNodeWallet, Mnemonic, Contract, MaxUint256 } from "ethers";
import { SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

const USDCE_TOKEN_ADDRESS    = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Polymarket V2 contracts (live April 28 2026)
// Source: https://docs.polymarket.com/resources/contracts
const PUSD_TOKEN_ADDRESS     = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const COLLATERAL_ONRAMP      = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const CTF_CONTRACT_ADDRESS   = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // Conditional Tokens
const CTF_EXCHANGE_ADDRESS   = "0xE111180000d2663C0091e4f400237545B87B996B"; // V2 CTF Exchange
const NEG_RISK_CTF_EXCHANGE  = "0xe2222d279d744050d28e00520010520000310F59"; // V2 Neg Risk Exchange

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ONRAMP_ABI = [
  "function wrap(address _asset, address _to, uint256 _amount) external",
];

// CTF conditional tokens are ERC-1155 — approval via setApprovalForAll
const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { index, proxyWalletAddress, amountUsdce } = req.body as {
      index?: unknown;
      proxyWalletAddress?: unknown;
      amountUsdce?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────────────

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    // proxyWalletAddress is accepted but no longer used in the transaction
    // (kept for backward compat with callers that still send it)
    if (
      proxyWalletAddress !== undefined &&
      proxyWalletAddress !== null &&
      proxyWalletAddress !== "" &&
      (typeof proxyWalletAddress !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(proxyWalletAddress))
    ) {
      return res.status(400).json({
        error: "Invalid proxyWalletAddress",
        message:
          "proxyWalletAddress must be a valid Ethereum address (0x…) if provided.",
      });
    }

    // ── Derive wallet via standard ethers.js HD derivation ────────────────────

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(SEED_PHRASE),
      `m/44'/60'/0'/0/${index}`,
    ).connect(provider);

    const walletAddress = wallet.address;
    const usdce  = new Contract(USDCE_TOKEN_ADDRESS,   ERC20_ABI,   wallet);
    const pusd   = new Contract(PUSD_TOKEN_ADDRESS,    ERC20_ABI,   wallet);
    const onramp = new Contract(COLLATERAL_ONRAMP,     ONRAMP_ABI,  wallet);
    const ctf    = new Contract(CTF_CONTRACT_ADDRESS,  ERC1155_ABI, wallet);

    // ── Fetch balances ────────────────────────────────────────────────────────

    const [usdceBalance, pusdBalance, nativeBalance] = await Promise.all([
      usdce.balanceOf(walletAddress) as Promise<bigint>,
      pusd.balanceOf(walletAddress) as Promise<bigint>,
      provider.getBalance(walletAddress),
    ]);

    // Total depositeable = USDC.e (will be wrapped) + any existing pUSD
    const balance = usdceBalance + pusdBalance;

    if (nativeBalance === 0n) {
      return res.status(400).json({
        error: "No gas",
        message: "Bot wallet has no POL to pay the transaction fee.",
      });
    }

    if (balance === 0n) {
      return res.status(400).json({
        error: "No USDC.e or pUSD",
        message: "Bot wallet has no USDC.e or pUSD to deposit.",
      });
    }

    // ── Determine deposit amount ──────────────────────────────────────────────

    let transferAmount: bigint;
    if (
      amountUsdce !== undefined &&
      amountUsdce !== "" &&
      amountUsdce !== null
    ) {
      transferAmount = BigInt(
        Math.round(parseFloat(String(amountUsdce)) * 1_000_000),
      );
      if (transferAmount <= 0n || transferAmount > balance) {
        return res.status(400).json({
          error: "Invalid amount",
          message: `Amount must be between 0 and ${(Number(balance) / 1_000_000).toFixed(6)} USDC.e.`,
        });
      }
    } else {
      // Default: deposit entire USDC.e balance
      transferAmount = balance;
    }

    // ── Step 1: Wrap USDC.e → pUSD via CollateralOnramp (if we have USDC.e) ─
    // pUSD is the V2 collateral. USDC.e must be wrapped before depositing.
    // If the wallet already has pUSD (e.g. from a previous partial wrap),
    // we skip the wrap for that portion.

    let pUsdToDeposit: bigint;

    if (usdceBalance > 0n) {
      // How much USDC.e to wrap — respect amountUsdce cap if set
      const wrapAmount =
        transferAmount <= usdceBalance ? transferAmount : usdceBalance;

      const approveTx = await usdce.approve(COLLATERAL_ONRAMP, wrapAmount);
      await approveTx.wait(1);

      const wrapTx = await onramp.wrap(
        USDCE_TOKEN_ADDRESS,
        walletAddress,
        wrapAmount,
      );
      await wrapTx.wait(1);

      // After wrap, recalculate total pUSD available
      pUsdToDeposit = (await pusd.balanceOf(walletAddress)) as bigint;
    } else {
      // Only pUSD available, no wrapping needed
      pUsdToDeposit = pusdBalance;
      if (pUsdToDeposit > transferAmount) pUsdToDeposit = transferAmount;
    }

    // ── Step 2: Approve pUSD → CTF Contract (MaxUint256, set-and-forget) ─────
    // In V2 there is NO Exchange.deposit(). The Exchange reads CTF token balances
    // directly and pulls them at fill time. The CLOB backend splits pUSD → YES/NO
    // CTF tokens when orders are matched. We just need the approvals in place.

    const approvePusdTx = await pusd.approve(CTF_CONTRACT_ADDRESS, MaxUint256);
    await approvePusdTx.wait(1);

    // ── Step 3: setApprovalForAll CTF tokens → Exchanges (skip if already set) ─
    const [isApprovedExchange, isApprovedNegRisk] = await Promise.all([
      ctf.isApprovedForAll(walletAddress, CTF_EXCHANGE_ADDRESS)  as Promise<boolean>,
      ctf.isApprovedForAll(walletAddress, NEG_RISK_CTF_EXCHANGE) as Promise<boolean>,
    ]);

    let approveExchangeHash: string | null = null;
    let approveNegRiskHash:  string | null = null;

    if (!isApprovedExchange) {
      const tx = await ctf.setApprovalForAll(CTF_EXCHANGE_ADDRESS, true);
      const receipt = await tx.wait(1);
      approveExchangeHash = receipt?.hash ?? tx.hash;
    }

    if (!isApprovedNegRisk) {
      const tx = await ctf.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true);
      const receipt = await tx.wait(1);
      approveNegRiskHash = receipt?.hash ?? tx.hash;
    }

    const amountFormatted = (Number(pUsdToDeposit) / 1_000_000).toFixed(6);

    return res.json({
      from: walletAddress,
      pUsdBalance: amountFormatted,
      pUsdApprovedToCtf: true,
      ctfApprovedToExchange: isApprovedExchange ? "already set" : approveExchangeHash,
      ctfApprovedToNegRiskExchange: isApprovedNegRisk ? "already set" : approveNegRiskHash,
      note: "USDC.e wrapped to pUSD. Approvals set. Bot will sync CLOB balance on next updateBalanceAllowance call.",
      proxyWalletAddress: proxyWalletAddress ?? null,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
