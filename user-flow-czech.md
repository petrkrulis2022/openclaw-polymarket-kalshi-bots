# OpenClaw — Kompletní průvodce pro uživatele

## 1. Připojení MetaMasku

Otevřete dashboard na adrese `:4001`. Klikněte na **Connect Wallet** — zobrazí se MetaMask, potvrďte připojení. Toto je vaše **osobní identita** na platformě. Každá MetaMask adresa dostane svého vlastního izolovaného obchodního bota.

---

## 2. Krok 1 — Nabití botí peněženky

Systém automaticky vygeneruje **dedikovanou botí peněženku** (HD peněženka odvozená na serveru) — to je peněženka, která bude skutečně obchodovat na Polymarketu. Není to vaše MetaMask peněženka.

Zobrazí se vám její adresa. Je třeba na ni poslat **USDT na síti Polygon**:

### Možnost A — Odeslání přes tlačítko MetaMask (doporučeno)

1. Zadejte částku USDT do vstupního pole
2. Klikněte na **Send USDT** → zobrazí se MetaMask popup
3. Potvrďte transakci v MetaMasku
4. USDT přejde z vaší MetaMask peněženky → do botí peněženky na Polygonu

### Možnost B — Ruční kopírování adresy

1. Klikněte na **Copy** a zkopírujte adresu botí peněženky
2. Otevřete MetaMask → Odeslat → vložte adresu → vyberte USDT na Polygonu → potvrďte

**Živé zůstatky** (USDT / USDC.e / POL gas) se aktualizují automaticky každých 30 sekund. Tlačítko **Next** se odemkne, jakmile má botí peněženka jakýkoliv zůstatek USDT nebo USDC.e.

> ⚠️ Botí peněženka také potřebuje malé množství **POL** (nativní token Polygonu) na poplatky za transakce (gas). Pošlete ~0,5–1 POL na stejnou adresu botí peněženky.

---

## 3. Krok 2 — Vygenerování API klíčů pro Polymarket

Polymarket vyžaduje API klíče svázané s **adresou botí peněženky** (ne vaším MetaMaskem). Je to proto, že příkazy jsou zadávány z botí peněženky.

Postup:

1. Přejděte na [polymarket.com/settings](https://polymarket.com/settings)
2. V MetaMasku **importujte botí peněženku** pomocí jejího soukromého klíče (v případě potřeby ho získáte z treasury)
3. Přepněte MetaMask na účet botí peněženky
4. Přejděte na **API Keys → Create Key**
5. Zkopírujte **API Key, API Secret a Passphrase**
6. Vložte všechny tři do formuláře OpenClaw a klikněte na **Save**

---

## 4. Krok 3 — Aktivace botů

### Převod USDT → USDC.e

Boti obchodují s USDC.e (stablecoin akceptovaný Polymarketem), nikoli s USDT.

- Klikněte na **Convert X USDT → USDC.e** — tím se spustí on-chain swap přes Uniswap V3 (stabilní pár, poplatek 0,01 %)
- Počkejte ~10–30 sekund na potvrzení transakce na Polygonu
- Po dokončení se zobrazí odkaz na PolygonScan

### Autonomní režim (volitelné)

Zapněte **Autonomní režim**, aby orchestrátor automaticky převáděl všechny budoucí vklady USDT → USDC.e každých 5 minut. Užitečné, pokud plánujete pravidelně doplňovat prostředky bez ručního převodu.

### Spuštění botů

Klikněte na **Start Bots** — orchestrátor spustí 5 obchodních strategií současně pro vaši peněženku:

| #   | Strategie                     | Co dělá                                                                                         |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Market Maker**              | Vkládá limitní příkazy na obě strany knihy příkazů, zachytává bid-ask spread                    |
| 2   | **Copy Trader**               | Zrcadlí obchody nejlepších obchodníků na Polymarketu v konfigurovatelném měřítku                |
| 3   | **Vnitrotržní arbitráž**      | Kupuje YES+NO, když jejich kombinovaná cena < $1 — garantovaný zisk bez ohledu na výsledek      |
| 4   | **Kupec zpoždění vypořádání** | Kupuje výherní akcie se slevou 97–99¢ během 24–72h zpoždění orákula, inkasuje $1 při vypořádání |
| 5   | **Mikrostruktura**            | Market making na velmi nízko-ceněných (0,1¢) nelikvidních trzích, škálováno přes 100+ pozic     |

Každý bot běží jako samostatný PM2 proces s vlastním rozsahem portů (`4010+`).

---

## 5. Po aktivaci

Jakmile boti běží, onboardingová obrazovka je nahrazena **Agent Wallet Card** zobrazující živé zůstatky, a hlavním dashboardem se sledováním portfolia a AI chat asistentem.

### Zastavení botů

Použijte tlačítko **Stop Bots** v Agent Wallet Card. Tím se korektně ukončí všech 5 PM2 procesů pro vaši peněženku. Prostředky zůstanou v botí peněžence — nic se automaticky nevybírá.

### Doplnění prostředků

Pošlete další USDT na stejnou adresu botí peněženky kdykoliv. Botí peněženka je **trvalá a deterministická** — opětovné připojení stejné MetaMask adresy vždy obnoví přesně stejnou botí peněženku. Pokud je zapnutý Autonomní režim, nové USDT se automaticky převede na USDC.e do 5 minut.

---

## Klíčové pojmy

| Pojem                  | Význam                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **MetaMask peněženka** | Vaše osobní identita — slouží pouze k identifikaci vás a volitelně k odesílání prostředků        |
| **Botí peněženka**     | HD peněženka generovaná serverem, která skutečně drží prostředky a zadává příkazy na Polymarketu |
| **USDT**               | Co posíláte z MetaMasku; musí být na síti Polygon                                                |
| **USDC.e**             | S čím boti skutečně obchodují na Polymarketu (převedeno přes Uniswap V3)                         |
| **POL**                | Nativní token Polygonu potřebný pro poplatky za transakce (gas) na botí peněžence (~0,5–1 POL)   |
| **Autonomní režim**    | Automaticky převádí příchozí USDT → USDC.e každých 5 minut bez ručního zásahu                    |
