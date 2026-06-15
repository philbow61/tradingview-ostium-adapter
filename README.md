# TradingView × Ostium Adapter

**Run any existing TradingView strategy as live leveraged trades on [Ostium](https://ostium.io)** —
the perpetual-futures DEX on Arbitrum for RWAs (forex, commodities, indices, crypto). Your Pine
strategy fires a webhook on each entry/exit; this service receives it, translates it, and executes
the trade for you — **gaslessly**, via a delegate key, with the strategy's contract count *ignored*
and position size re-derived from your real on-chain collateral.

> ✅ **Proven live on Ostium testnet (Arbitrum Sepolia):** a real `BINANCE:BTCUSDT` MA-cross alert
> opened a BTC short (tx [`0xa67a9fc4…`](https://arbitrum-sepolia.blockscout.com/tx/0xa67a9fc46cd78e29e39e188514372f0ce4d6307102f36a9eab191277e5a81e39)),
> then the opposite cross **flipped** it to a long (tx [`0x197dd6a2…`](https://arbitrum-sepolia.blockscout.com/tx/0x197dd6a22dce72e014d5e5bbe4d8b280c711aeba6bed719ce556d1fda211de80)) — chart → webhook → settled position, no human in the loop.

```
TradingView strategy ──webhook(JSON)──▶ Fastify receiver ──queue──▶ Worker ──▶ Builder SDK ──▶ Ostium
   alert(once-per-bar-close)             secret · dedup · 200-fast   map · size · flip   delegated+gasless (ERC-4337)
```

## Why it's non-trivial (what the adapter handles for you)
- **TradingView can't trade** — it only emits a webhook. Everything real (auth, sizing, signing, settlement) is this service.
- **Acts on target-state, not raw buy/sell** — each alert declares the desired position (`long`/`short`/`flat`); the worker computes open / close / **flip** against your live on-chain position. Robust to duplicate, missed, or reordered alerts.
- **Sizes from live on-chain collateral** — never from TradingView's `contracts` (a backtest artifact).
- **Oracle-settled lifecycle** — confirms each order settles into a position, or auto-cancels & reclaims a stuck open.
- **Delegated + gasless** — signs with a *delegate* key (not your funds key) and needs no ETH. A leaked delegate key can trade but **cannot move funds**.

Built on the TypeScript [`@ostium/builder-sdk`](https://www.npmjs.com/package/@ostium/builder-sdk) — delegated + gasless via ERC-4337.

---

# Quick start on Replit (testnet · no install · no tunnel)

The fastest way to try the adapter. Replit gives the Repl a **public HTTPS URL** automatically (so
TradingView can reach it without cloudflared) and an encrypted **Secrets** store (so there's no local
`.env`). The template is **pinned to testnet** — mainnet is intentionally blocked unless you set
`ALLOW_MAINNET=true`.

[![Run on Replit](https://replit.com/badge/github/philbow61/tradingview-ostium-adapter)](https://replit.com/github/philbow61/tradingview-ostium-adapter)

1. Click **Run on Replit** → it imports the repo and runs `npm install`.
2. Open the **Secrets** tab (🔒) and add:
   - `DELEGATE_PRIVATE_KEY` — your **delegate** key (NOT your funds-wallet key)
   - `TRADER_ADDRESS` — your funds wallet (public address; holds **testnet** USDC)
   - `RPC_URL` — an Arbitrum **Sepolia** RPC URL (e.g. Alchemy)
   - `STRAT_DEMO_SECRET` — any random string (shared webhook secret for all demo strategies)

   > Network is pre-pinned to testnet via `.replit`. Leave it — going to mainnet needs a deliberate
   > `ALLOW_MAINNET=true` and real funds.
   >
   > **Faster:** click **"Edit as JSON"** in the Secrets tab and paste all of them at once:
   > ```json
   > { "DELEGATE_PRIVATE_KEY": "0x…", "TRADER_ADDRESS": "0x…", "RPC_URL": "https://…", "STRAT_DEMO_SECRET": "any-random-string" }
   > ```
   > (Replit can't pre-fill secret values from the repo — for security, every fork sets its own.)
3. **Register your delegate via the Ostium UI** — in Ostium's Builder/delegate flow, point your
   wallet's delegate at the Safe it shows. This keeps your **funds-wallet key off Replit entirely**
   (the adapter only ever holds the delegate key).
4. Click **Run**. Open the webview URL (the "open in new tab" ↗ button):
   - **Dashboard** → `<your-repl-url>/`
   - **Webhook** → `<your-repl-url>/tv/demo`

   It trades **live on Ostium testnet by default**. Until your Secrets are set it safely runs
   dry-run (no signing key → no trades); once `DELEGATE_PRIVATE_KEY` + `TRADER_ADDRESS` are present
   and your delegate is registered (Ostium UI), signals execute for real. For logs-only, copy
   `config.example.yaml` → `config.yaml` and set `btc-demo-001` → `mode: dry_run`.
5. In TradingView, create the alert with **Webhook URL = `<your-repl-url>/tv/demo`** — same wiring as
   [§8 below](#8--wire-tradingview), just no tunnel.

> ⚠️ A dev Repl **sleeps when idle**, so keep the workspace tab open/running while you demo — the URL
> is live only while the Repl runs. For an always-on listener, deploy a **Reserved VM** (paid; see the
> commented block in `.replit`).

---

# Setup walkthrough (zero → live trade) — local

## Prerequisites
- **Node 20+** (built on 22) and macOS/Linux.
- An **Ostium account with testnet USDC** (Arbitrum Sepolia) and a small amount of testnet ETH in the *delegate* path is **not** needed (gasless).
- A **delegate** set up via Ostium's Builder flow (gives you a delegate private key + a Safe smart-account address). Docs: <https://docs.ostium.com/developer/sdk/overview>.
- For the **real TradingView path**: a paid **TradingView** plan (Premium trial is plenty) with **2FA enabled** (required for webhooks), and a tunnel tool — we use **cloudflared** (no signup; ngrok also works).
- An **Arbitrum Sepolia RPC URL** (e.g. Alchemy).

## 1 · Install
```bash
git clone <this-repo> && cd OstiumTradingView
npm install
npm test            # 17 tests should pass
```

## 2 · Secrets — `.env`
```bash
cp .env.example .env
```
Fill in:
```
DELEGATE_PRIVATE_KEY=0x...     # the DELEGATE key (NOT your funds wallet key)
TRADER_ADDRESS=0x...           # your funds wallet (holds USDC) — public address
OSTIUM_NETWORK=testnet         # testnet (Arbitrum Sepolia) | mainnet (Arbitrum One)
RPC_URL=https://arb-sepolia.g.alchemy.com/v2/<key>
STRAT_DEMO_SECRET=<any-random-string>  # shared secret for all demo strategies
```
The adapter only ever holds the **delegate** key. Your funds-wallet key stays out of the server.

## 3 · Register the delegate (one-time, trader-signed)
Your trader wallet must point its on-chain delegate at the adapter's Safe. Either use Ostium's
Builder UI, **or** use the bundled script:
```bash
# Add your funds-wallet key to .env temporarily:  TRADER_PRIVATE_KEY=0x...
npm run register-delegate      # signs setDelegate(<our Safe>) from your wallet
# then DELETE TRADER_PRIVATE_KEY from .env again
```
Verify it took effect:
```bash
npm run delegate-info          # → ✅ ADAPTER AUTHORIZED
```
> ⚠️ **One delegate per wallet.** The Ostium UI's gasless mode uses the same slot — if you trade
> manually in the UI it will overwrite the adapter (and vice-versa). For a clean setup, use a
> **dedicated wallet** for the adapter.

## 4 · Strategies — `config.yaml`
```bash
cp config.example.yaml config.yaml
```
Each strategy maps a `strategy_id` (sent in the webhook) to a wallet/sizing/pair policy. The demo
ships `btc-demo-001` (BTC, 24/7), **live by default** (testnet). Set `mode: dry_run` for logs-only.
Sizing modes: `fixed_notional` (default), `percent_of_equity`, `risk_percent`.

## 5 · Verify reads & cache pairs
```bash
npm run probe        # confirms SDK reads, prints balance/positions, caches data/pairs.json
```

## 6 · Dry-run the whole pipeline (no real trades)
The shipped config is **live**; for a no-trade dry run set `btc-demo-001` → `mode: dry_run` in `config.yaml`, then:
```bash
npm start            # terminal 1 — receiver + dashboard on :8080
npm run fake-tv      # terminal 2 — posts long → flip short → flat; watch it RESOLVE the plan
```
Open the **dashboard** at <http://localhost:8080/> to watch the same flow visually (position card +
order-lifecycle timeline).

## 7 · Go live + expose a public URL
1. Set `btc-demo-001` → `mode: live` in `config.yaml`.
2. Start the receiver and a tunnel:
   ```bash
   npm start                                   # terminal 1
   cloudflared tunnel --url http://localhost:8080   # terminal 2  (brew install cloudflared)
   ```
   cloudflared prints a `https://<random>.trycloudflare.com` URL — that's your public endpoint.
3. Verify TradingView can reach you:
   ```bash
   curl https://<random>.trycloudflare.com/healthz   # → {"ok":true,...}
   ```
   > trycloudflare URLs are **ephemeral** — you get a new one each run; update the alert if you restart.

## 8 · Wire TradingView
1. **Pine Editor** → paste [`strategies/ma_cross_ostium.pine`](strategies/ma_cross_ostium.pine) → **Add to chart** on a **live 24/7 crypto** symbol, e.g. `BINANCE:BTCUSDT`, **1-minute**.
2. Strategy **settings (⚙)**: `strategy_id` = the market's id (e.g. `btc-demo-001` — see the table below), `Adapter secret` = your `STRAT_DEMO_SECRET`, `Dry run` = **off**, optional `Take-profit %` / `Stop-loss %` (default 5 / 2; `0` = off → exit only on the next cross). (Use Fast 9 / Slow 21 for deliberate signals, or 2/3 for frequent ones.)
3. **Create Alert**: Condition = the strategy / **"Order fills only"** · Message = exactly `{{strategy.order.alert_message}}` · Notifications → **Webhook URL** = `https://<random>.trycloudflare.com/tv/demo`.
4. On each MA cross, TradingView POSTs → the adapter opens / flips / closes a live position.

**Demo multiple markets at once** — run one copy of the Pine per chart, all with the same
`STRAT_DEMO_SECRET` and the same webhook URL; just set each chart's `strategy_id` per the config:

| TradingView chart | `strategy_id` | Ostium pair | Hours |
|---|---|---|---|
| `BINANCE:BTCUSDT` | `btc-demo-001` | BTC/USD | 24/7 |
| `BINANCE:ETHUSDT` | `eth-demo-001` | ETH/USD | 24/7 |
| `BINANCE:SOLUSDT` | `sol-demo-001` | SOL/USD | 24/7 |
| `OANDA:XAUUSD` | `gold-demo-001` | XAU/USD | market hours |
| `TVC:USOIL` | `oil-demo-001` | CL/USD | market hours |
| `OANDA:EURUSD` | `eurusd-demo-001` | EUR/USD | forex hours |

The webhook path (`/tv/demo`) is the same for all — the adapter routes by `strategy_id` + `secret` in
the payload, not the URL. Each strategy is gated to its own pair (`allowed_pairs`), so the right Pine
must be on the right chart. (For a catch-all that trades whatever chart it's on, set a strategy's
`allowed_pairs: []`.)

## 9 · Watch it trade
Open the **dashboard** → <http://localhost:8080/> (or `https://<random>.trycloudflare.com/` through
the tunnel): an Ostium-branded operator view with a status bar (delegate ✅/❌, kill-switch), a live
position card (side, PnL, entry/mark/liq, **TP/SL**, leverage), and a color-coded order-lifecycle
timeline (`received → opened → flip → closed`) with explorer tx links. It polls every 3s and is
read-only — it never trades. Or use the raw endpoints:
```bash
curl https://<random>.trycloudflare.com/events     # received → opened {txHash} → flip → ...
npm run positions                                  # current on-chain position
```
Each `opened`/`closed` event includes a `txHash` you can open on the Arbitrum Sepolia explorer.

## Don't have/want TradingView? Use the simulated sender
`npm run fake-tv` POSTs the **exact** webhook JSON a TradingView alert would (long → flip → flat) at
the live receiver — same pipeline, deterministic, no chart/tunnel needed. Great as the reliable demo.

## Stop trading
Disable the TradingView alert, **or** set `global.kill_switch: true` in `config.yaml` and restart
(the worker halts before any side effect).

---

## Repo layout
| Path | What |
|------|------|
| `src/` | Fastify receiver + **dashboard** (`dashboard.html`/`reader.ts`), worker (target-state + flip saga + settlement), symbol mapper, sizer, dedup, Builder SDK wrapper, notifier |
| `scripts/` | `probe`, `register-delegate`, `delegate-info`, `live-smoke`, `live-flip`, `fake-tv`, `order-status`, `cancel-pending`, `check`, `positions` |
| `strategies/` | `ma_cross_ostium.pine` — example TradingView strategy that emits the webhook JSON |
| `test/` | Vitest suite (17 tests) |

## Troubleshooting
- **`command not found: ngrok`** → use cloudflared: `brew install cloudflared` then `cloudflared tunnel --url http://localhost:8080`.
- **Alert fires but nothing happens / chart frozen** → you're on a closed market (weekend stock/forex). Use a **24/7 crypto** symbol (`BINANCE:BTCUSDT`) with a live, ticking price.
- **`NotDelegate` / trades revert** → your wallet's delegate isn't ours (the UI took the slot). Run `npm run register-delegate`, confirm with `npm run delegate-info` (✅).
- **Order pending / not settling** → testnet oracle keeper latency; the worker waits ~150s then auto-cancels & reclaims. Re-fire or use a live moment.
- **It's flipping constantly** → MAs too sensitive (e.g. 2/3 on 1m). Use 9/21 or a higher timeframe.

## Notes & limitations
- **Testnet-first**, self-custody, single-operator. Multi-tenant (trading for others) is out of scope (regulatory).
- **Live ≠ backtest:** different price feed, funding/rollover, slippage, and liquidation mean live results differ from TradingView's tester.
- Built with the **TypeScript** [`@ostium/builder-sdk`](https://www.npmjs.com/package/@ostium/builder-sdk) (delegated + gasless via Pimlico/ERC-4337).
