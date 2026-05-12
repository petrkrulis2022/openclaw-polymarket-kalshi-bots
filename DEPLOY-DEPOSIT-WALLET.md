# Deploy Deposit Wallet for Client #6 (User Slot 5, HD Index 15)

## Context

EOA `0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0` (HD index 15) holds ~38.8 pUSD.  
Polymarket V2 CLOB blocks pure EOA orders: `"maker address not allowed, please use the deposit wallet flow"`.  
Solution: Deploy a Deposit Wallet (ERC-1967 proxy) + POLY_1271 signature mode.

## Step 1 — Pull and deploy new code

```bash
cd ~/openclaw-polymarket-kalshi-bots
git pull origin multi-user

# Restart treasury (picks up new deposit-polymarket.ts routes)
pm2 restart treasury

# Restart orchestrator (picks up new users.ts start-bots logic)
pm2 restart orchestrator

pm2 logs treasury --lines 20   # verify no startup errors
pm2 logs orchestrator --lines 20
```

## Step 2 — Pre-compute deposit wallet address (dry run)

```bash
curl -s "http://localhost:3001/deposit-polymarket/address?index=15" | jq .
```

Expected response:
```json
{
  "depositWalletAddress": "0x<NEW_DEPOSIT_WALLET>",
  "eoa": "0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0",
  "index": 15
}
```

Save the `depositWalletAddress` — you'll need it for Step 5.

## Step 3 — Run the full deposit wallet setup

```bash
curl -s -X POST http://localhost:3001/deposit-polymarket \
  -H "Content-Type: application/json" \
  -d '{"index": 15}' | jq .
```

This call is **idempotent** — safe to retry. It will:
1. Deploy the deposit wallet via Polymarket relayer (gasless, ~30-60s polling)
2. Transfer 38.8 pUSD from EOA to deposit wallet (requires POL gas on EOA)
3. Set 3 approvals FROM deposit wallet via relayer batch (gasless)

Expected success response:
```json
{
  "depositWalletAddress": "0x...",
  "eoa": "0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0",
  "isDeployed": true,
  "deployTxHash": "0x...",
  "pUsdTransferTxHash": "0x...",
  "approvalTxHash": "0x...",
  "depositWalletPusdBalance": "38.808767",
  "note": "..."
}
```

### If relayer returns 401/403 (auth required)
The relayer may require Builder API credentials for WALLET-CREATE.  
In that case, proceed to **Fallback: On-chain deployment** below.

### If EOA has no POL for gas
The pUSD transfer (step 5 in the flow) requires POL.  
Send ~0.5 POL to `0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0` first.

## Step 4 — Update ecosystem-u5.json with deposit wallet address

```bash
DEPOSIT_WALLET="<paste depositWalletAddress from Step 2>"

python3 -c "
import json, sys
path = 'orchestrator/data/envs/ecosystem-u5.json'
with open(path) as f: d = json.load(f)
dw = sys.argv[1]
for app in d['apps']:
    app['env']['POLYMARKET_WALLET_ADDRESS'] = dw
    app['env']['POLYMARKET_FUNDER_ADDRESS'] = dw
    app['env']['POLYMARKET_SIGNATURE_TYPE'] = 'POLY_1271'
with open(path, 'w') as f: json.dump(d, f, indent=2)
print('Updated ecosystem-u5.json')
" "$DEPOSIT_WALLET"

cat orchestrator/data/envs/ecosystem-u5.json | jq '.apps[0].env | {POLYMARKET_WALLET_ADDRESS, POLYMARKET_FUNDER_ADDRESS, POLYMARKET_SIGNATURE_TYPE}'
```

## Step 5 — Restart u5 bots with new config

```bash
pm2 stop market-maker-u5 copy-trader-u5 in-market-arb-u5 resolution-lag-u5 microstructure-u5
pm2 delete market-maker-u5 copy-trader-u5 in-market-arb-u5 resolution-lag-u5 microstructure-u5

pm2 start orchestrator/data/envs/ecosystem-u5.json
pm2 save

# Verify bots started
pm2 ls | grep u5
pm2 logs market-maker-u5 --lines 30
```

Bots should log:
```
[clob] creating API key sig_type=3 poly_address=<EOA> funder=<DEPOSIT_WALLET>
[clob] API key created/derived ok: key=...
```

---

## Fallback: On-chain deposit wallet deployment (if relayer requires auth)

If the relayer returns a 401/403 error on WALLET-CREATE, use this on-chain approach.
This requires POL for gas but bypasses the relayer entirely.

### Check factory contract function on Polygonscan
Visit: https://polygonscan.com/address/0x00000000000Fb5C9ADea0298D729A0CB3823Cc07#writeContract

Look for a `deploy(address owner)` or `create(bytes32 walletId)` function.

### Alternative: Use a foundry/cast one-liner
```bash
# Install foundry if not present
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Derive deposit wallet address
DEPOSIT_WALLET=$(cast call 0x00000000000Fb5C9ADea0298D729A0CB3823Cc07 \
  "predictAddress(address)(address)" \
  0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0 \
  --rpc-url https://polygon-bor-rpc.publicnode.com)
echo "Deposit wallet: $DEPOSIT_WALLET"
```

(The exact function name depends on the factory ABI — check Polygonscan.)

---

## Verification after setup

```bash
# Check deposit wallet pUSD balance on-chain
cast call 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB \
  "balanceOf(address)(uint256)" \
  "<DEPOSIT_WALLET_ADDRESS>" \
  --rpc-url https://polygon-bor-rpc.publicnode.com

# Check CTF approvals from deposit wallet
cast call 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 \
  "isApprovedForAll(address,address)(bool)" \
  "<DEPOSIT_WALLET_ADDRESS>" \
  0xE111180000d2663C0091e4f400237545B87B996B \
  --rpc-url https://polygon-bor-rpc.publicnode.com

# Check CLOB balance via updateBalanceAllowance
# (happens automatically when the market-maker bot starts)
```
