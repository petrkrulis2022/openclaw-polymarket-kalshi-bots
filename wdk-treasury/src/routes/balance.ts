/**
 * routes/balance.ts
 *
 * POST /balance
 *
 * Returns USDT, USDC.e and native POL balances for a user bot wallet,
 * plus the pUSD balance on the deterministic Polymarket deposit wallet.
 * Internal-only endpoint — not exposed via public proxy.
 *
 * Body:    { index: number }   (must be >= 10)
 * Response: { address, usdt, usdce, nativePol, depositWalletAddress, depositWalletPusd }
 */

import { Router, Request, Response, NextFunction } from "express";
import { JsonRpcProvider, Contract, HDNodeWallet, Mnemonic, keccak256, AbiCoder, concat, getCreate2Address, zeroPadValue, toBeHex } from "ethers";
import { getAccount, USDT_TOKEN_ADDRESS, formatUsdT, SEED_PHRASE, POLYGON_RPC } from "../wdk.js";

const USDCE_TOKEN_ADDRESS =
  process.env["USDCE_TOKEN_ADDRESS"] ??
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const PUSD_TOKEN_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPL = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

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
  const salt = zeroPadValue(eoaAddress, 32);
  const initCodeHash = initCodeHashERC1967(
    DEPOSIT_WALLET_IMPL,
    AbiCoder.defaultAbiCoder().encode(["address"], [eoaAddress]),
  );
  return getCreate2Address(DEPOSIT_WALLET_FACTORY, salt, initCodeHash);
}

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

const router = Router();

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;
  try {
    const { index } = req.body as { index?: unknown };

    if (typeof index !== "number" || !Number.isInteger(index) || index < 10) {
      return res.status(400).json({
        error:
          "index must be an integer >= 10 (indices 0-9 are reserved for system wallets)",
      });
    }

    account = await getAccount(index);

    // Derive EOA address for deposit wallet calculation
    const mnemonic = Mnemonic.fromPhrase(SEED_PHRASE);
    const eoaWallet = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
    const eoaAddress = eoaWallet.address;
    const depositWalletAddress = computeDepositWalletAddress(eoaAddress);

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const pusdContract = new Contract(PUSD_TOKEN_ADDRESS, ERC20_ABI, provider);
    const usdceContract = new Contract(USDCE_TOKEN_ADDRESS, ERC20_ABI, provider);
    const usdtContract = new Contract(USDT_TOKEN_ADDRESS, ERC20_ABI, provider);

    const [address, usdt, usdce, native, depositWalletPusd] = await Promise.all([
      account.getAddress() as Promise<string>,
      usdtContract.balanceOf(eoaAddress) as Promise<bigint>,
      usdceContract.balanceOf(eoaAddress) as Promise<bigint>,
      account.getBalance() as Promise<bigint>,
      pusdContract.balanceOf(depositWalletAddress) as Promise<bigint>,
    ]);

    return res.json({
      address,
      usdt: formatUsdT(usdt),
      usdce: formatUsdT(usdce),
      nativePol: native.toString(),
      depositWalletAddress,
      depositWalletPusd: formatUsdT(depositWalletPusd),
    });
  } catch (err) {
    return next(err);
  } finally {
    try {
      account?.dispose?.();
    } catch {}
  }
});

export default router;
