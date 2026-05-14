# Plan: Fix 502 Withdraw + Recover Stuck pUSD (index 17)

## Root Causes

1. **502 on Withdraw**: `wdk-treasury/src/routes/withdraw.ts` returns 400 "No USDT balance to withdraw" when the bot EOA has 0 USDT. The orchestrator (`users.ts` Step 3) blindly wraps this as a 502. The graceful skip pattern that already exists for the USDC.e swap step (lines ~668-672) is **missing** from the USDT transfer step (lines ~681-696).

2. **Stuck pUSD**: 7.997 pUSD landed in `poly_funder_address` = `0x9250537...` (a Gnosis Safe proxy), **not** in the POLY_1271 deposit wallet `0x3f2Ed7...`. No existing treasury route can move pUSD out of a Gnosis Safe.

3. **Balance display bug**: `balance.ts` reads pUSD from the deposit wallet only → shows 0.00. Self-fixes after recovery if pUSD ends up in deposit wallet, or becomes irrelevant if sent directly to MetaMask.

---

## Key Unknown — MUST Verify Before Phase 2

Does Bot EOA `0xC55947b5FCa9d7904bE97e80d340f68411E96E08` **own** the Safe `0x9250537...`?

```bash
cast call 0x9250537Af12dCdC108B81bc949bA9D6dfA19c80E "getOwners()(address[])" --rpc-url <polygon-rpc>
```

- If **EOA is in the owner list** → Phase 2 rescue works.
- If **EOA is NOT an owner** → rescue route will reject; need Polymarket support or alternative approach.

---

## Addresses (Account: 0xAc52cA... / Index 17)

| Role                                | Address                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| MetaMask (login)                    | `0xAc52cA0FE59Cdc1B1698f7e77f16688322f5FEb2`                       |
| Bot EOA (index 17)                  | `0xC55947b5FCa9d7904bE97e80d340f68411E96E08`                       |
| Deposit wallet (POLY_1271)          | `0x3f2Ed7e5158C3b06E35193D54e98E3d829c41618`                       |
| Gnosis Safe (`poly_funder_address`) | `0x9250537Af12dCdC108B81bc949bA9D6dfA19c80E` ← **7.997 pUSD here** |

---

## Implementation Steps

### Phase 1 — Fix the 502 (4-line change, safe for ALL users)

**File:** `orchestrator/src/routes/users.ts` lines ~689-696

Currently the USDT transfer block hard-returns 502 on any failure from treasury. Add the same graceful skip that already exists for the USDC.e swap (lines ~668-672):

```ts
if (!withdrawRes.ok) {
  const body = await withdrawRes.text();
  // Graceful skip if no USDT to withdraw (same pattern as USDC.e swap skip above)
  if (!body.includes("No USDT balance")) {
    return res.status(502).json({
      error: `Withdrawal transfer failed (${withdrawRes.status}): ${body}`,
    });
  }
  // No USDT on EOA — skip this step, continue to deposit wallet drain
}
```

Other users with USDT are **completely unaffected** — they still get their USDT transferred.

---

### Phase 2 — New treasury route: `rescue-safe-pusd` (new file, zero impact on existing routes)

**New file:** `wdk-treasury/src/routes/rescue-safe-pusd.ts`

Clone of `rescue-safe-usdc.ts` with these differences:

- Reads **pUSD** balance from the Safe (`PUSD_TOKEN_ADDRESS = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`)
- Body has `toAddress` param — pUSD goes directly to MetaMask (not EOA + CTF deposit)
- Encodes `pUSD.transfer(toAddress, balance)` as the Safe transaction
- No CTF Exchange deposit step (withdrawing, not depositing)
- Keeps all Safe ownership and threshold checks from `rescue-safe-usdc.ts`

**Register in:** `wdk-treasury/src/index.ts`

```ts
import rescueSafePusdRouter from "./routes/rescue-safe-pusd.js";
app.use("/rescue-safe-pusd", rescueSafePusdRouter);
```

---

### Phase 3 — New admin orchestrator endpoint

**File:** `orchestrator/src/routes/admin.ts`

Add `POST /admin/rescue-pusd` behind `requireAdminPassword`:

```ts
// Body: { metamaskAddress: string }
// → looks up user → poly_funder_address is the Safe
// → calls treasury POST /rescue-safe-pusd with { index, safeAddress, toAddress }
```

---

### Phase 4 — Admin UI (optional)

Add a "Rescue pUSD from Safe" button in `AdminPanel.tsx` (user dropdown + button → calls `POST /admin/rescue-pusd`).

**OR:** skip the UI entirely and use curl for this one-off operation:

```bash
curl -X POST http://localhost:3002/admin/rescue-pusd \
  -H "Content-Type: application/json" \
  -d '{ "adminPassword": "...", "metamaskAddress": "0xAc52cA0FE59Cdc1B1698f7e77f16688322f5FEb2" }'
```

---

## Files to Modify

| File                                          | Change                                         |
| --------------------------------------------- | ---------------------------------------------- |
| `orchestrator/src/routes/users.ts`            | Phase 1: 4-line graceful skip (~lines 689-696) |
| `wdk-treasury/src/routes/rescue-safe-pusd.ts` | Phase 2: **NEW FILE**                          |
| `wdk-treasury/src/index.ts`                   | Phase 2: register new route                    |
| `orchestrator/src/routes/admin.ts`            | Phase 3: new rescue-pusd endpoint              |
| `web-dashboard/src/components/AdminPanel.tsx` | Phase 4: optional UI button                    |

## NOT Modified

- `withdraw.ts` — unchanged
- `balance.ts` — unchanged (self-fixes or irrelevant after rescue)
- `withdraw-deposit.ts` — unchanged
- `redeem.ts` — unchanged
- Any logic other users depend on

---

## Verification Checklist

1. **Check Safe ownership** on server:
   ```bash
   cast call 0x9250537Af12dCdC108B81bc949bA9D6dfA19c80E "getOwners()(address[])" --rpc-url <polygon>
   ```
2. **After Phase 1:** `POST /api/orchestrator/users/0xAc52cA.../withdraw` → returns 200 (Step 3 gracefully skipped, Step 4 deposit drain runs)
3. **After Phase 2+3:** call `POST /admin/rescue-pusd` → check tx on Polygonscan
4. Confirm MetaMask `0xAc52cA...` receives ~7.997 pUSD on-chain
