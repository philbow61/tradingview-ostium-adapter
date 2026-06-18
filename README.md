# TradingView × Ostium Adapter

**Run any TradingView strategy as live leveraged trades on [Ostium](https://ostium.io)** — the
perpetual-futures DEX on Arbitrum for RWAs (crypto, forex, commodities, indices). Your Pine strategy
fires a webhook on each entry/exit; this service receives it, translates it, and executes the trade
**gaslessly** via a delegate key — with the strategy's contract count ignored and position size
re-derived from your real on-chain collateral. Comes with an Ostium-branded **dashboard** (positions,
order-lifecycle timeline, session PnL, one-click close).

> ✅ **Proven live on Ostium testnet (Arbitrum Sepolia):** a real `BINANCE:BTCUSDT` MA-cross alert
> opened a BTC short, then the opposite cross flipped it to a long — chart → webhook → settled
> on-chain position, no human in the loop.

```
TradingView strategy ──webhook──▶ Fastify receiver ──queue──▶ Worker ──▶ Builder SDK ──▶ Ostium
   alert (order fills)            secret · dedup · ack-fast    target-state · size · flip   delegated + gasless
```

**What it handles for you:** acts on *target-state* (`long`/`short`/`flat`) so it computes open / close /
**flip** against your live position (robust to duplicate or missed alerts); sizes from on-chain
collateral, never TradingView's `contracts`; confirms oracle settlement (auto-reclaims a stuck open);
signs with a **delegate key** (never your funds key) and needs no ETH.

---

# Run on Replit (1-click · testnet · no tunnel)

Replit gives you a public HTTPS URL (no cloudflared) and encrypted Secrets (no local `.env`).

[![Run on Replit](https://replit.com/badge/github/philbow61/tradingview-ostium-adapter)](https://replit.com/github/philbow61/tradingview-ostium-adapter)

1. Click **Run on Replit** → it imports the repo and installs deps.
2. **Secrets** tab (🔒) — add:
   - `DELEGATE_PRIVATE_KEY` — your **delegate** key (NOT your funds-wallet key)
   - `TRADER_ADDRESS` — your funds wallet (public address; holds **testnet** USDC)
   - `RPC_URL` — an Arbitrum **Sepolia** RPC URL (e.g. Alchemy)
   - `STRAT_DEMO_SECRET` — any random string (shared webhook secret; also authorizes the close button)
3. **Register your delegate** via the Ostium UI — point your wallet's delegate at the Safe it shows.
   (Keeps your funds-wallet key off Replit entirely.)
4. Click **Run**, open the webview URL (↗): the **dashboard** is at `/`, the **webhook** is at `/tv/demo`.
5. [Connect a TradingView strategy](#connect-a-tradingview-strategy) using that webhook URL.

Network is pinned to **testnet** (mainnet is blocked unless you set `ALLOW_MAINNET=true`). It trades
**live by default**; until your Secrets are set it safely runs dry-run (no signing key → no trades).
A dev Repl sleeps when idle — keep the tab open while demoing, or [deploy a Reserved VM](https://docs.replit.com/cloud-services/deployments/reserved-vm-deployments) for always-on.

---

# Run locally

**Prerequisites:** Node 20+, an Ostium **testnet** account with USDC, an Arbitrum Sepolia RPC URL, and
(for the real TradingView path) a paid TradingView plan with 2FA + a tunnel — we use `cloudflared`.

```bash
git clone https://github.com/philbow61/tradingview-ostium-adapter && cd tradingview-ostium-adapter
npm install
npm test                              # the test suite should pass

cp .env.example .env                  # fill DELEGATE_PRIVATE_KEY, TRADER_ADDRESS, RPC_URL, STRAT_DEMO_SECRET
#   (config.example.yaml runs by default — 6 markets, live; copy to config.yaml to customize)

# Register your delegate once (or via the Ostium UI):
#   add TRADER_PRIVATE_KEY=0x... to .env temporarily, then:
npm run register-delegate
npm run delegate-info                 # → ✅ ADAPTER AUTHORIZED   (then delete TRADER_PRIVATE_KEY)

npm start                             # receiver + dashboard on http://localhost:8080
```

Open the **dashboard** → <http://localhost:8080/>. Then either:

- **No TradingView needed:** `npm run fake-tv` — posts the exact webhook JSON (long → flip → flat) at
  the receiver and trades it live on testnet. The reliable demo.
- **Real TradingView:** expose a public URL and wire an alert:
  ```bash
  cloudflared tunnel --url http://localhost:8080     # prints https://<id>.trycloudflare.com
  ```
  Use `https://<id>.trycloudflare.com/tv/demo` as the webhook below. (trycloudflare URLs change each run.)

To run dry-run only (logs, no trades): copy `config.example.yaml` → `config.yaml` and set the
strategies to `mode: dry_run`.

---

# Configure strategies (`config.yaml`)

All trading behaviour — leverage, position size, which markets, live vs dry-run — lives in
`config.yaml`. The shipped `config.example.yaml` runs as-is; copy it to `config.yaml` to customize.
Keys/secrets stay in env (never in this file). **Config is read once at startup — edit it, then
restart** (Replit: Stop ▸ Run). Restarting mid-session is safe: open positions live on-chain and the
adapter reconciles to them on the next signal.

Each entry under `strategies:` maps one `strategy_id` (the value your TradingView alert sends) to one
market and its rules:

| Field | What it does |
|---|---|
| `enabled` | Turn this strategy on/off. |
| `mode` | `live` = real trades · `dry_run` = log the planned action only, no signing. |
| `secret_env` | Name of the env var holding this strategy's shared webhook secret (the demos all share `STRAT_DEMO_SECRET`). |
| `default_leverage` | Leverage when the alert doesn't specify one (e.g. `10` = 10×). |
| `max_leverage` | Hard cap; also clamped to the pair's own max. |
| `slippage_pct` | Max slippage tolerated on the order (e.g. `1.0` = 1%). |
| `sizing.default_mode` | How to size — see the table below. |
| `sizing.default_value` | The number that mode uses (USD notional, or a %). |
| `sizing.max_position_notional` | Upper bound on a single position's notional (USD). |
| `sizing.allow_payload_override` | If `true`, an alert may override mode/value/leverage. |
| `allowed_pairs` | Markets this strategy may trade (e.g. `[BTC/USD]`). `[]` = any listed market the chart resolves to (catch-all). |
| `risk.max_open_positions` | Max concurrent positions for this strategy. |
| `risk.require_sl_for_risk_mode` | Require a stop-loss when using `risk_percent` sizing. |

**How size is decided.** Leverage comes from config (or the alert, if override is on); the position
**size is computed from your live on-chain USDC**, never TradingView's `contracts`. Collateral is
derived: `collateral = notional ÷ leverage`.

| `sizing.default_mode` | Notional is… | Example |
|---|---|---|
| `fixed_notional` | a flat USD amount | `100` → $100 notional → at 10× = **$10 collateral** |
| `percent_of_equity` | `value%` × equity × leverage | `2` → 2% of your USDC, levered |
| `risk_percent` | sized so hitting the stop-loss loses `value%` of equity | `1` → risk 1% per trade (needs a stop-loss) |

**Global settings** (top of the file) apply to everything:

| Field | What it does |
|---|---|
| `network` | `testnet` (Arbitrum Sepolia) or `mainnet` (also requires env `ALLOW_MAINNET=true`). |
| `kill_switch` | `true` halts **all** execution immediately. |
| `min_collateral_usdc` | Floor for collateral per trade. |
| `max_lag_sec_hard_cap` | Server cap on signal freshness — older alerts are dropped as stale. |
| `tv_allowed_ips` · `enforce_ip_allowlist` | Optional IP allowlist for TradingView's webhook IPs (off by default). |

> ⚠️ Strategies run **live by default**. Set `mode: dry_run` per strategy to log without trading.

---

# Connect a TradingView strategy

Run one copy of [`strategies/ma_cross_ostium.pine`](strategies/ma_cross_ostium.pine) per market:

1. **Pine Editor** → paste the script → **Add to chart** on the market's chart (table below).
2. Strategy **settings (⚙)**: set `strategy_id` (per the table), `Adapter secret` = your
   `STRAT_DEMO_SECRET`, `Dry run` = **off**. (Fast/Slow MA `9`/`21` for deliberate signals, `2`/`3` for frequent.)
3. **Create Alert**: Condition = the strategy / **"Order fills only"** · Message = exactly
   `{{strategy.order.alert_message}}` · Notifications → **Webhook URL** = `<your-url>/tv/demo`.

| TradingView chart | `strategy_id` | Pair | Hours |
|---|---|---|---|
| `BINANCE:BTCUSDT` | `btc-demo-001` | BTC/USD | 24/7 |
| `BINANCE:ETHUSDT` | `eth-demo-001` | ETH/USD | 24/7 |
| `BINANCE:SOLUSDT` | `sol-demo-001` | SOL/USD | 24/7 |
| `OANDA:XAUUSD` | `gold-demo-001` | XAU/USD | market hours |
| `TVC:USOIL` | `oil-demo-001` | CL/USD | market hours |
| `OANDA:EURUSD` | `eurusd-demo-001` | EUR/USD | forex hours |

One webhook URL + one secret cover all markets — the adapter routes by `strategy_id` + `secret`, not
the URL. The alert runs on TradingView's servers; the adapter only runs while your Repl/process is up.

### Use your own existing strategy (no Pine edits)
The adapter only needs the webhook JSON with a target-state `sentiment`, so any strategy can drive it.
Leave its code alone and set the **alert Message** to this (TradingView's `{{strategy.market_position}}`
is literally `long`/`short`/`flat`):
```json
{"secret":"YOUR_STRAT_DEMO_SECRET","strategy_id":"custom-001","sentiment":"{{strategy.market_position}}","ticker":"{{ticker}}","nonce":"{{strategy.order.id}}-{{time}}"}
```
`custom-001` is a catch-all in `config.example.yaml` (`allowed_pairs: []` → any Ostium-listed market the
chart is on). It mirrors **direction/timing only** — sizing comes from config, one net position per pair
(no pyramiding / partial exits).

> **Notes:** testnet-first, self-custody, single-operator. A leaked delegate key can trade but **cannot
> move funds**. Live ≠ backtest (different feed, funding, slippage, liquidation).
