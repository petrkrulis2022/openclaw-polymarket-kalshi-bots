# Přehled obchodních strategií

Všechny strategie běží na Polymarket (CLOB), pokud není uvedeno jinak. Boti jsou očíslováni podle priority implementace.

---

## Bot 1 — Market Maker

**Stav**: Aktivní (port :3003)  
**Strategie**: Zachytávání bid-ask spreadu

### Jak to funguje

Vkládá resting limitní příkazy na obě strany knihy v likvidních predikčních trzích. Vydělává na spreadu, když jsou plněny obě nohy. Nikdy nepřijímá směrové riziko — okamžitě zajišťuje nebo vyrovnává pozici, pokud se zásoby stanou nevyváženými.

### Logika vstupu

- Výběr trhů s dostatečnou likviditou CLOB (spread na vrcholu knihy > 1¢)
- Vkládání nabídek na `mid - half_spread`, poptávek na `mid + half_spread`
- Přecenění příkazů, pokud se střed posune o více než 0,5¢

### Výstup / Riziko

- Pokud čisté zásoby překročí prahovou hodnotu, rozšíří spread na přetížené straně
- Zrušení všech příkazů, pokud je využití > 90 %
- Tvrdý stop: zrušení všeho, pokud nerealizovaný PnL klesne o > $X za sezení

### Klíčové metriky

- Zachycený spread na plnění
- Poměr nevyváženosti zásob
- Míra plnění (jak často jsou plněny obě nohy)

### Integrace Ylop

- Půjčování proti existujícím zásobovým pozicím pro financování dodatečné hloubky MM
- Uzamčené páry YES+NO ≈ $1 garantovaně → ideální zajištění pro Ylop

---

## Bot 2 — Meziplatformní arbitráž (Kalshi ↔ Polymarket)

**Stav**: Navrženo, zatím nepostaveno (vyžaduje účet na Kalshi)  
**Cíl**: Příští týden

### Jak to funguje

Stejná binární událost se obchoduje na Kalshi i Polymarket. Když je stejný výsledek oceněn různě na obou platformách, kupuje se levnější strana a (synteticky) prodává dražší strana. Zachytává se konvergence.

### Logika vstupu

1. Načtení ceny YES na obou platformách pro stejnou podkladovou událost
2. Výpočet čistého spreadu: `polymarket_yes_ask - kalshi_yes_bid` (nebo naopak)
3. Procházení obou knih příkazů pro nalezení skutečného spreadu váženého objemem — **nepoužívat pouze vrchol knihy**
4. Vstup pouze pokud spread vážený objemem > poplatky na obou stranách + rezerva pro skluz

### Kritické varování

Naivní verze **prodělala peníze** při testování: byl vidět 13% kotovaný spread, ale jeho spotřebování naplnilo příkaz a zanechalo 0% skutečný spread. Vždy procházet celou knihu před vstupem.

### Poplatky / Náklady

- Polymarket: poplatek příjemce na CLOB
- Kalshi: plán poplatků tvůrce/příjemce
- Gas: Polygon (minimální)
- Čistá prahová hodnota: musí přesáhnout všechny poplatky o alespoň 1 % pro vstup

### Výstup

- Zavření obou noh současně, když spread komprimuje na < 0,1 %
- Nebo držení do vypořádání, pokud jsou obě strany stejným výsledkem

### Integrace Ylop

- Noha A (levnější platforma) může být vložena jako zajištění pro půjčení na nohu B
- Snižuje počáteční potřebný kapitál o ~50 %

---

## Bot 3 — Copy Trader

**Stav**: Aktivní (port :3004)  
**Strategie**: Kopírování výkonných obchodníků na Polymarket s konfigurovatelným škálováním

### Jak to funguje

Dotazuje Polymarket Data API na pozice sledovaného obchodníka každých N sekund. Když zvýší nebo sníží pozici, zrcadlí obchod ve škálované velikosti (`copyRatio × traderDelta`). Podporuje mód ručního schválení nebo plně automatický.

### Logika vstupu

1. Porovnání aktuálního snímku s předchozím pro každého sledovaného obchodníka
2. Výpočet delty: `currSize - prevSize` pro každé tokenId
3. Pokud `|delta| × curPrice > minSignalUsd`, generuje signál
4. Škálování našeho příkazu: `ourShares = min(|delta| × copyRatio, allocationUsd / curPrice)`
5. V ručním módu: zařazení do fronty čekající na schválení — uživatel schvaluje/odmítá
6. V automatickém módu: okamžité provedení

### Výběr obchodníků

- Přidání obchodníků pomocí URL profilu na Polymarket (automatická extrakce 0x adresy)
- Konfigurace pro každého obchodníka: alokace ($), copy ratio (0–2×), mód (ruční/automatický)
- Odebrání kdykoli — snímek vymazán, žádné nové signály

### Sledování pozic

Dashboard zobrazuje pro každou otevřenou pozici:

- **Naše**: velikost, kapitál (velikost × průměrná cena), nerealizovaný PnL, realizovaný PnL
- **Obchodníka**: velikost, kapitál, nerealizovaný PnL (z živého snímku)

### Riziko

- Každý obchodník má samostatný strop alokace
- copyRatio omezuje naši velikost na obchod vzhledem k jejich
- minSignalUsd zabraňuje prachůvým signálům

### Integrace Ylop

- Kopírované pozice s vysokým přesvědčením mohou být použity jako zajištění Ylop
- Půjčení proti potvrzené pozici pro financování dalších kopírovaných signálů

---

## Bot 4 — Vnitrotržní arbitráž (YES + NO < $1)

**Stav**: Plánováno (příští implementace)  
**Strategie**: Čistá matematická arbitráž v rámci jednoho trhu

### Jak to funguje

Na binárním trhu Polymarket musí YES + NO být přesně $1 při vypořádání. Pokud je trh nelikvidní nebo nekoordinovaný, někdy `YES_ask + NO_ask < $1`. Koupí obou je garantován zisk bez ohledu na výsledek.

### Vstupní vzorec

```
spread = 1.0 - (YES_ask + NO_ask)
```

Vstup když `spread > poplatky + rezerva pro skluz` (typicky potřeba spread > 0,5–1 %).

### Kontrola hloubky knihy příkazů

Nekontrolovat pouze vrchní cenu. Procházet celou knihu:

```
pro každou úroveň YES:
  pro každou úroveň NO:
    pokud YES_price + NO_price < 1.0:
      profitable_volume += min(YES_volume, NO_volume)
```

Vstupovat pouze pokud je ziskový objem dostatečně velký, aby obchod ospravedlnil.

### Rozšíření na více výsledků

Funguje také na trzích s více výsledky:

- **Více-binární**: `YES_A + YES_B + ... < $1` → koupit všechny výsledky
- **Negativní riziko**: `NO × N < N - 1` → koupit všechny NO

### Provedení

1. Přihlásit se k odběru websocketu CLOB pro cílové trhy
2. Při každé aktualizaci knihy příkazů znovu spustit vzorec spreadu
3. Pokud je detekován pozitivní spread a kontrola hloubky projde → vystavit obě nohy současně (použít limitní příkazy oceněné na spreadu)
4. Obě nohy se musí naplnit v krátkém okně — okamžitě zrušit nepárovanou nohu

### Riziko

- Prováděcí riziko: jedna noha se naplní, druhá ne → směrová expozice do zrušení
- Riziko vypořádání: žádné (garantovaný návrat $1)
- Likviditní riziko: tenká kniha znamená omezený objem

### Integrace Ylop

- Párová pozice YES+NO ≈ $1 garantovaně při vypořádání
- Ideální zajištění pro půjčky Ylop — půjčování proti uzamčenému páru čekající na vypořádání

---

## Bot 5 — Kupec zpoždění vypořádání

**Stav**: Plánováno  
**Strategie**: Nákup „vyhraných" akcií od netrpělivých prodejců při zpoždění orákula

### Jak to funguje

Po vyřešení události v reálném světě (hra skončí, volby rozhodnuty, cena překročí úroveň) trvá orákulu Polymarket 24–72 hodin, než ji oficiálně vypořádá. Během tohoto okna netrpěliví držitelé vítězných lístků prodávají se slevou — 97–99¢ místo čekání na $1.

Koupit tyto zlevněné akcie, inkasovat $1 při vypořádání orákula.

### Profil výnosu

- 1–3 % výnos za 24–72 hodin
- Annualizováno: 1 % za 2 dny ≈ 180 % APY na nasazený kapitál
- Dokonce i 0,5 % za 3 dny = ~60 % APY

### Logika vstupu

1. Monitorovat výsledky událostí přes zpravodajský feed / X API / sportovní API
2. Když je výsledek potvrzen (např. tým vyhraje zápas), zkontrolovat stav orákula Polymarket
3. Pokud je vypořádání stále čekající (`resolved: false`, výsledek potvrzen externě):
   - Zkontrolovat cenu YES pro vítězný výsledek — pokud `price < 0.99`, vypočítat očekávaný výnos
   - Koupit do limitu pozice pokud `výnos > prahová hodnota` (např. > 0,5 %)
4. Držet do vypořádání orákula, inkasovat $1

### Potřebné datové zdroje

- Sport: ESPN / Sportradar API pro výsledky her
- Politika: Associated Press / Reuters volební feedy
- Krypto: Chainlink / CoinGecko pro trhy spouštěné cenou
- Stav orákula Polymarket: GraphQL nebo REST API

### Riziko

- Spor orákula: výsledek je zpochybněn → vypořádání zpožděno nebo zrušeno (vzácné)
- Špatná identifikace: bot si myslí, že se událost vyřešila, ale nevyřešila → koupí špatnou stranu
- Zmírnění: vyžadovat 2+ nezávislé potvrzovací zdroje před vstupem

### Kapitálová efektivita

- Velikost pozice omezena časovým rámcem vypořádání orákula — nelze recyklovat kapitál do vypořádání
- Půjčka Ylop proti drženým pozicím pro přesměrování kapitálu před vypořádáním orákula

### Integrace Ylop

- Držení pozic za 99¢ jako zajištění Ylop
- Půjčování proti nim pro financování nových obchodů čekající na výplatu $1
- Efektivně recykluje kapitál, který by jinak sedel nečinně 1–3 dny

---

## Bot 6 — Mikrostruktura nízké ceny („Bot za 0,1¢")

**Stav**: Plánováno  
**Strategie**: Market making za extrémně nízkých cen na nelikvidních trzích

### Jak to funguje

V nelikvidních predikčních trzích má YES akcie obchodující se za 0,1¢ (0,1% implikovaná pravděpodobnost) často bid-ask spread 0,1¢ → 0,3¢. Vkládá resting nabídky za 0,1¢ přes mnoho trhů, prodává za 0,2–0,3¢ při pohybu ceny. Velmi malý zisk na obchod, ale škálovaný přes 100+ trhů.

### Logika vstupu

1. Prohledávání trhů s:
   - Vrchní nabídkou < 0,3¢
   - Dobou do expirace > 90 dní (snižuje riziko totální ztráty)
   - Jakýmkoli objemem za posledních 7 dní (prokazuje existenci likvidity)
2. Vkládání limitních nabídek za 0,1¢ (nebo aktuální vrchní nabídku)
3. Po plnění okamžitě vložit poptávku za 0,2–0,3¢
4. Opakovat

### Kritéria prohledávání trhů

- `curPrice < 0.003` (< 0,3¢)
- `expiry > now + 90d`
- `volume_7d > 0`
- Není na černé listině (trhy blížící se vypořádání, kontroverzní výsledky)

### Rizikový profil

- **Riziko totální ztráty**: pokud se událost vyřeší jako YES při držení NO za 0,1¢ → ztráta celé pozice
- **Zmírnění**:
  - Vstupovat pouze na trhy s > 3 měsíci do expirace
  - Rozložení sázek přes 100+ pozic — diverzifikace snižuje varianci
  - Omezení velikosti pozice na $1–5 na trh
  - Maximální celková expozice: `N_positions × avg_price × avg_size`
- **Očekávaná hodnota na pozici**: mírně pozitivní (spread) s občasnými událostmi totální ztráty

### Správa pozic

- Sledování každé pozice samostatně (odděleno od hlavních zásob)
- Automatické zrušení všeho u každé pozice přibližující se 30denní expiraci
- Realizovaný PnL sledován odděleně od ostatních botů

### Škálovatelnost

- Zisk škáluje s počtem pokrytých trhů
- 100 pozic × $2 průměrné náklady × 50% míra plnění × 100% přirážka = hrubý cíl
- Hlavní omezení: nalezení dostatečného počtu trhů splňujících kritéria

### Integrace Ylop

- Méně vhodné pro zajištění Ylop (nízká individuální hodnota pozice, nejistý výsledek)
- Lze použít Ylop pro financování počátečního nasazení kapitálu přes mnoho malých pozic

---

## CEX Latency Arb (Neimplementováno — Budoucnost)

**Strategie**: Pohyb ceny Binance/Coinbase → Polymarket kurzy BTC/ETH zaostávají o 30–90 s

### Proč je odloženo

- Poplatky zavedeny specificky pro zničení naivních příjemcových botů — marže mizí, pokud není pouze tvorba
- Vyžaduje co-location nebo velmi rychlou infrastrukturu
- Potřeba strategie příkazů tvůrce: předpovědět pohyb, předem vložit příkaz, čekat na plnění

### Kdy se stane životaschopným

- Když máme cestu provedení pouze tvůrce (slevy namísto poplatků)
- Po ověření latence < 1 s od cenového feedu po odeslání příkazu
- Vstup pouze když BTC **se již výrazně pohnul** (potvrzený trend, ne předpověď)

---

## Matice priority strategií

| #   | Bot                     | Riziko        | Složitost    | Požadavek kapitálu | Vhodnost Ylop |
| --- | ----------------------- | ------------- | ------------ | ------------------ | ------------- |
| 1   | Market Maker            | Střední       | Střední      | Střední            | Vysoká        |
| 2   | Meziplatformní arbitráž | Střední       | Vysoká       | Vysoká             | Vysoká        |
| 3   | Copy Trader             | Střední       | Nízká        | Nízká              | Střední       |
| 4   | Vnitrotržní arbitráž    | Nízké         | Střední      | Nízká              | Velmi vysoká  |
| 5   | Kupec zpoždění          | Velmi nízké   | Střední      | Střední            | Velmi vysoká  |
| 6   | Mikrostruktura          | Nízké-Střední | Nízká        | Nízká              | Nízká         |
| —   | CEX Latency Arb         | Vysoké        | Velmi vysoká | Vysoká             | Střední       |

---

## Sdílená technická infrastruktura

- **CLOB Websocket**: Odběry knih příkazů pro boty 1, 4
- **Dotazování Data API**: Snímky pozic pro boty 3, 5
- **Monitorování událostí**: Zpravodajský/sportovní/orákulový feed pro bota 5
- **Prohledávač trhů**: Dávkový sken pozic pro bota 6
- **Orchestrátor**: Směrování kapitálu, integrace Ylop, rizikové limity pro všechny boty
- **Pokladna**: Sledování zůstatku USDC, půjčování přes Ylop
