# Eda's Wallet Map — OpenClaw Bots (FRESH START)

⚠️ **THIS DOCUMENT IS FOR THE CLEAN RESTART USING EDA ONLY.** Previous mixed setup has been retired.

## Wallets & Their Roles

### 1. Eda's MetaMask — `0x8727...B2B6`

**Personal identity only.** Used to log in to openclawbot.uk and to send USDT/USDC.e to fund the bot. Does NOT hold trading funds. MetaMask wallet = your username in the system.

---

### 2. Edovo Bot EOA (HD Wallet, Index 15) — `0xcefF...c3E0`

**Server-side signing wallet.** Derived deterministically from the server's HD seed when Eda's MetaMask first connected. This EOA's private key is what the bot uses to cryptographically sign every Polymarket order (POLY*1271 standard). It is NOT the Polymarket account itself — it is the \_key holder* for the account below. Already imported into MetaMask as "Edovo bot" for visibility.

---

### 3. WDK Deposit Wallet (POLY_1271) — `0x50f0aC2...6341`

**The actual Polymarket trading account.** This is a WDK smart contract wallet (CREATE2-deployed). It is shown in the OpenClaw dashboard as "Deposit Wallet (Polymarket POLY_1271)". USDC.e sent here via the "Deposit USDC.e → Polymarket" dashboard button becomes the collateral the bots trade from. The bot EOA (#2) signs orders on behalf of this wallet using POLY_1271. You never need to touch this wallet directly.

---

## ⚠️ RETIRED IDENTITIES — DO NOT USE ANYMORE

### Main MetaMask Identity — `0xD7CA...B1e`

**Status:** Disconnect from OpenClaw. Keep only for personal fund transfers if needed.

### Mybot EOA — `0xAc52...Eb2`

**Status:** Retired. Was associated with Main MetaMask. Do not import into MetaMask anymore.

### Polymarket Direct Connection Proxies (old, from manual polymarket.com connections)

| Address         | Created by                               | Historical Use                                                  | **ACTION REQUIRED**                                                                |
| --------------- | ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `0xa31e...cA1A` | Edovo bot EOA directly to polymarket.com | 346 past trades — MOST RECENT ACTIVITY (check for USDC balance) | ✅ **CHECK NOW:** connect edovo bot key, check Polymarket balance, withdraw if any |
| `0xB3B0...d6`   | Eda MetaMask directly to polymarket.com  | Minimal use                                                     | Can be ignored (likely empty)                                                      |
| `0xF823...210`  | Main MetaMask directly to polymarket.com | Minimal use                                                     | Can be ignored (likely empty)                                                      |
| `0x2Ad4...655`  | Mybot EOA directly to polymarket.com     | Minimal use                                                     | Can be ignored (likely empty)                                                      |

---

## Token Glossary

| Token      | What it is                                     | Where it lives in correct flow |
| ---------- | ---------------------------------------------- | ------------------------------ |
| **USDT**   | Tether — what you send from Eda's MetaMask     | Bot EOA (#2) in transit        |
| **USDC.e** | Bridged USDC on Polygon — what bots trade with | WDK Deposit Wallet (#3)        |
| **POL**    | Polygon gas token for the Bot EOA              | Bot EOA (#2)                   |

---

## Correct Money Flow

```
Eda MetaMask (#1)
    │ "Fund Agent": send USDT on Polygon
    ▼
Bot EOA (#2) — holds USDT + POL for gas
    │ OpenClaw "Convert USDT → USDC.e" (Uniswap V3 swap)
    ▼
Bot EOA (#2) — now holds USDC.e
    │ OpenClaw "Deposit USDC.e → Polymarket" button
    ▼
WDK Deposit Wallet (#3) — 0x50f0aC2...  ← USDC.e collateral here
    │ Bots place orders signed by Bot EOA using POLY_1271
    │ (No API keys, no manual Polymarket.com connection needed)
    ▼
Winnings settle back into WDK Deposit Wallet (#3) as USDC.e
    │ OpenClaw Withdraw → back to Bot EOA (#2)
    ▼
Bot EOA (#2) → send back to Eda MetaMask (#1) if desired
```

---

## Signing Authority and Speed (Important)

### Who signs the trade when user clicks "Team A/B Scored"

- **Signer:** Bot EOA (`0xcefF...c3E0`) private key on server.
- **Trading account:** WDK Deposit Wallet (`0x50f0...6341`) on Polymarket.
- **Mechanism:** Bot EOA signs POLY_1271 orders authorizing execution for the WDK wallet.

So the user MetaMask does **not** sign per-goal trades. The bot signs instantly server-side.

### Does orchestrator assign funds to bots?

- For hockey and football, orchestrator stores config and enforces guardrails (trade amount, watched game, readiness checks).
- Actual available buying power comes from collateral already deposited into the WDK wallet.
- Orchestrator does not "mint" funds; it only controls limits and routing.

### Can this be pre-signed for speed?

- Not in a reusable way for dynamic market orders.
- Price, liquidity, and order parameters are fresh at trigger time, so signatures are generated at execution time.
- The existing speed path is already optimized: button click -> bot `/manual-trigger` endpoint -> immediate signed FOK order attempt.

### Spending cap / safety

- Per-bot cap is enforced by configured trade amount (`trade-amount` endpoint).
- Combined hockey+football cap is bounded by collateral guardrails.
- Setting trade amount to `0` disables execution for that bot.

---

## Fresh Start Checklist

1. ✅ **Check `0xa31e372e...` for outstanding USDC** — connect edovo bot key, check Polymarket balance, withdraw if any
2. ✅ **Disconnect Main MetaMask from OpenClaw** — do not log in with `0xD7CA...`
3. ✅ **Disconnect Mybot EOA** — do not import `0xAc52...` into MetaMask
4. **Connect Eda MetaMask** (`0x8727...`) to openclawbot.uk
5. Send USDT to Bot EOA (`0xcefF...`) via "Fund Agent"
6. Convert USDT → USDC.e in dashboard
7. Click "Deposit USDC.e → Polymarket" to fund the WDK wallet (`0x50f0aC2...`)
8. Configure and start hockey-bot and football-bot

---

---

# Edova mapa peněženek — OpenClaw Bots

## Peněženky a jejich role

### 1. Edova MetaMask — `0x8727ce9103289b7df1E55dcb3E18Afd07E12B2B6`

**Pouze osobní identita.** Slouží k přihlášení na openclawbot.uk a k zasílání USDT/USDC.e pro financování bota. Nedrží žádné obchodní prostředky. MetaMask peněženka = tvoje uživatelské jméno v systému.

---

### 2. Bot EOA (HD peněženka) — `0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0`

**Podepisovací peněženka na serveru (index 15).** Deterministicky odvozena ze seed fráze serveru při prvním připojení Edovy MetaMasky. Privátní klíč tohoto EOA bot používá k podepisování každé objednávky na Polymarketu (standard POLY*1271). Není to samotný Polymarket účet — je to \_držitel klíče* pro účet níže. Importována do MetaMasku jako „Edovo bot" pouze pro přehlednost.

---

### 3. WDK Vkladová peněženka (POLY_1271) — `0x50f0aC2FCDfdAE8F5418e455441B4B33b2186341`

**Skutečný obchodní účet na Polymarketu.** Jde o WDK smart contract peněženku (CREATE2-deployed). V dashboardu OpenClaw zobrazena jako „Deposit Wallet (Polymarket POLY_1271)". USDC.e zaslané sem přes tlačítko „Deposit USDC.e → Polymarket" se stávají kolaterálem, se kterým boti obchodují. Bot EOA (#2) podepisuje objednávky jménem této peněženky pomocí POLY_1271. Tuto peněženku není třeba nijak ručně ovládat.

---

### ⚠️ ZASTARALÉ / CHYBNÉ PENĚŽENKY — NEPOUŽÍVAT

Vznikly omylem přímým připojením peněženek na polymarket.com. Nejsou součástí správného toku OpenClaw:

| Adresa                                       | Vzniklá připojením                      | Stav                                        |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------- |
| `0xa31e372e43C8D7d106d9a1A465C79a58e834cA1A` | Edovo bot EOA přímo na polymarket.com   | 346 minulých obchodů, zkontrolovat zůstatek |
| `0xB3B08dbD01B7B5F1e182063B85608E70C38B82d6` | Edova MetaMask přímo na polymarket.com  | Pravděpodobně prázdná                       |
| `0xF823aC6EEa645265ff0101F56A4676E6E630a210` | Hlavní MetaMask přímo na polymarket.com | Pravděpodobně prázdná                       |
| `0x2Ad4022395798c2Bce5cAf4462f58884703a7655` | Mybot EOA přímo na polymarket.com       | Pravděpodobně prázdná                       |

---

## Správný tok peněz

```
Edova MetaMask (#1)
    │ „Fund Agent": pošli USDT na Polygonu
    ▼
Bot EOA (#2) — drží USDT + POL na gas
    │ OpenClaw „Convert USDT → USDC.e" (swap přes Uniswap V3)
    ▼
Bot EOA (#2) — nyní drží USDC.e
    │ tlačítko OpenClaw „Deposit USDC.e → Polymarket"
    ▼
WDK Vkladová peněženka (#3) — 0x50f0aC2...  ← kolaterál USDC.e zde
    │ Boti zadávají příkazy podepsané Bot EOA pomocí POLY_1271
    │ (Žádné API klíče, žádné ruční připojení na polymarket.com)
    ▼
Výhry se vrátí do WDK peněženky (#3) jako USDC.e
    │ OpenClaw Withdraw → zpět na Bot EOA (#2)
    ▼
Bot EOA (#2) → lze poslat zpět na Edovu MetaMasku (#1)
```
