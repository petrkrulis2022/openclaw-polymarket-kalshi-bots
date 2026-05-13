# Eda's Wallet Map — OpenClaw Bots

## Wallets & Their Roles

### 1. Eda's MetaMask — `0x8727ce9103289b7df1E55dcb3E18Afd07E12B2B6`

**Personal identity only.** Used to log in to openclawbot.uk and originally to send USDT. Does NOT hold trading funds. MetaMask wallet = your username in the system.

---

### 2. Bot EOA (HD Wallet) — `0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0`

**Server-side trading wallet.** Derived deterministically from the SEED_PHRASE on the server when Eda's MetaMask connected. This is what actually signs transactions and interacts with Polymarket. Shows up in MetaMask as "Edovo bot" because you imported its private key. Currently holds: **131.59 POL (gas), 0 USDT, 0 USDC.e**.

---

### 3. Deposit Wallet (POLY_1271 / CREATE2) — `0xa31e372e43C8D7d106d9a1A465C79a58e834cA1A`

**Polymarket's smart contract wallet** — deterministically deployed by Polymarket's factory, controlled by the Bot EOA. This is where USDC.e lives before it becomes pUSD. The dashboard shows **38.00 USDC.e** here. This is NOT a regular wallet — you can't send from it with MetaMask. Only the gasless relayer can move funds out of it.

---

### 4. Polymarket Proxy (richhhhhmo) — `0x1ba1509802134764021510Be390523FEba297766`

**Polymarket's internal trading account.** This is your Gnosis Safe proxy on Polymarket — it holds **pUSD** (Polymarket's internal USD used for betting). Dashboard shows **1.18 pUSD** here. The $7.00 visible on Polymarket's website lives in this wallet.

---

### 5. Polymarket Deposit Address — `0x8e2Ab1957a4eA8C1B68113CbAFf9ddC0De9f9c2C`

**Polymarket's bridge address.** This is where Polymarket told you to send USDC to top up via their "Transfer Crypto" UI. The 7 USDC sitting here should auto-convert to pUSD in the Polymarket proxy above.

---

## Token Glossary

| Token      | What it is                                           | Where it lives        |
| ---------- | ---------------------------------------------------- | --------------------- |
| **USDT**   | Tether — what you deposit from Eda's MetaMask        | Bot EOA (#2)          |
| **USDC.e** | Bridged USDC on Polygon — what bots trade with       | Deposit Wallet (#3)   |
| **pUSD**   | Polymarket's internal dollar — used for placing bets | Polymarket Proxy (#4) |
| **USDC**   | Native USDC — what Polymarket's deposit UI accepts   | Deposit Address (#5)  |
| **POL**    | Polygon gas token                                    | Bot EOA (#2)          |

---

## Money Flow

```
Eda MetaMask (#1)
    │ send USDT on Polygon
    ▼
Bot EOA (#2) — holds USDT + POL
    │ Uniswap V3 swap (USDT → USDC.e)
    ▼
Bot EOA (#2) — now holds USDC.e
    │ "Deposit USDC.e → Polymarket" button
    ▼
Deposit Wallet (#3) — holds USDC.e  ← 38.00 USDC.e is here now
    │ Polymarket gasless relayer converts USDC.e → pUSD
    ▼
Polymarket Proxy (#4) — holds pUSD  ← 1.18 pUSD + $7 from bridge
    │ bots place trades
    ▼
Winnings settle back to Proxy (#4) as pUSD
    │ Withdraw button → redeem pUSD → USDC.e → back to Bot EOA
    ▼
Bot EOA (#2) — can then send USDT back to Eda MetaMask (#1)
```

---

## Current Situation

- **38.00 USDC.e** is in the Deposit Wallet (#3) — needs to be deposited to Polymarket using the **"Deposit USDC.e → Polymarket"** button on the dashboard. That will move it to pUSD in the Proxy (#4) for the bots to trade.
- **1.18 pUSD** is already in the Proxy — bots are already using this.
- **$7 USDC** at the deposit address (#5) — Polymarket should auto-process this into pUSD soon.
- **131.59 POL** at the Bot EOA — plenty of gas, no action needed.

**Bottom line: click "Deposit USDC.e → Polymarket" on the dashboard to move the 38 USDC.e into trading.**

---

---

# Edova mapa peněženek — OpenClaw Bots

## Peněženky a jejich role

### 1. Edova MetaMask — `0x8727ce9103289b7df1E55dcb3E18Afd07E12B2B6`

**Pouze osobní identita.** Slouží k přihlášení na openclawbot.uk a původně k odeslání USDT. Nedrží žádné obchodní prostředky. MetaMask peněženka = tvoje uživatelské jméno v systému.

---

### 2. Bot EOA (HD peněženka) — `0xcefFeeE55e295A09A7EFB6A8e64082BEA59Ac3E0`

**Obchodní peněženka na serveru.** Deterministicky odvozena ze SEED_PHRASE na serveru při prvním připojení Edovy MetaMasky. Tato peněženka skutečně podepisuje transakce a komunikuje s Polymarketem. V MetaMasku se zobrazuje jako „Edovo bot", protože byl importován její privátní klíč. Aktuální stav: **131,59 POL (gas), 0 USDT, 0 USDC.e**.

---

### 3. Vkladová peněženka (POLY_1271 / CREATE2) — `0xa31e372e43C8D7d106d9a1A465C79a58e834cA1A`

**Chytrá smluvní peněženka Polymarketu** — deterministicky nasazena továrnou Polymarketu, ovládána Bot EOA. Sem přichází USDC.e předtím, než se přemění na pUSD. Dashboard zobrazuje **38,00 USDC.e**. Není to běžná peněženka — nelze z ní posílat přes MetaMask. Prostředky z ní může přesouvat pouze bezplynný reléér (gasless relayer).

---

### 4. Polymarket Proxy (richhhhhmo) — `0x1ba1509802134764021510Be390523FEba297766`

**Interní obchodní účet Polymarketu.** Toto je tvůj Gnosis Safe proxy na Polymarketu — drží **pUSD** (interní dolar Polymarketu používaný pro sázení). Dashboard ukazuje **1,18 pUSD**. Těch $7,00 viditelných na webu Polymarketu je v této peněžence.

---

### 5. Vkladová adresa Polymarketu — `0x8e2Ab1957a4eA8C1B68113CbAFf9ddC0De9f9c2C`

**Přemosťovací adresa Polymarketu.** Sem Polymarket říkal, abys poslal USDC přes jejich rozhraní „Transfer Crypto". Těch 7 USDC, které tam sedí, by se mělo automaticky přeměnit na pUSD v Proxy výše.

---

## Slovník tokenů

| Token      | Co to je                                                | Kde se nachází          |
| ---------- | ------------------------------------------------------- | ----------------------- |
| **USDT**   | Tether — co posíláš z Edovy MetaMasky                   | Bot EOA (#2)            |
| **USDC.e** | Přemostěné USDC na Polygonu — s čím obchodují boti      | Vkladová peněženka (#3) |
| **pUSD**   | Interní dolar Polymarketu — pro sázení                  | Polymarket Proxy (#4)   |
| **USDC**   | Nativní USDC — co přijímá vkladové rozhraní Polymarketu | Vkladová adresa (#5)    |
| **POL**    | Polygon gas token                                       | Bot EOA (#2)            |

---

## Tok peněz

```
Edova MetaMask (#1)
    │ pošli USDT na Polygonu
    ▼
Bot EOA (#2) — drží USDT + POL
    │ swap přes Uniswap V3 (USDT → USDC.e)
    ▼
Bot EOA (#2) — nyní drží USDC.e
    │ tlačítko „Deposit USDC.e → Polymarket"
    ▼
Vkladová peněženka (#3) — drží USDC.e  ← zde je nyní 38,00 USDC.e
    │ bezplynný reléér Polymarketu přemění USDC.e → pUSD
    ▼
Polymarket Proxy (#4) — drží pUSD  ← 1,18 pUSD + $7 z mostu
    │ boti obchodují
    ▼
Výhry se vrátí do Proxy (#4) jako pUSD
    │ tlačítko Withdraw → vyplacení pUSD → USDC.e → zpět na Bot EOA
    ▼
Bot EOA (#2) — lze pak poslat USDT zpět na Edovu MetaMasku (#1)
```

---

## Aktuální situace

- **38,00 USDC.e** je ve Vkladové peněžence (#3) — je třeba ji vložit na Polymarket pomocí tlačítka **„Deposit USDC.e → Polymarket"** na dashboardu. Tím se přesune jako pUSD do Proxy (#4), kde s ní budou obchodovat boti.
- **1,18 pUSD** je již v Proxy — boti to již používají.
- **7 USDC** na vkladové adrese (#5) — Polymarket by to měl brzy automaticky přeměnit na pUSD.
- **131,59 POL** na Bot EOA — dostatek gasu, není třeba nic dělat.

**Závěr: klikni na „Deposit USDC.e → Polymarket" na dashboardu a přesuň 38 USDC.e do obchodování.**
