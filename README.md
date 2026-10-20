# Paper Trader

A Windows desktop app for practising trades with fake money on real US market prices, with a machine-learning signal that shows its own track record, including when it is no better than guessing.

![The trading desk: watchlist, chart with indicators, order ticket and the model's signal](docs/desk.png)

## Download (Windows)

1. Get `PaperTrader-Setup-<version>.exe` from the repository's **Releases** page.
2. Run it. It installs for your Windows user only (no admin prompt) and adds Paper Trader to the Start menu. You can tick a desktop shortcut too.
3. Open Paper Trader, name your paper account, pick your starting cash and a few symbols to watch.

Good to know:

- The installer isn't signed, so Windows may say "Windows protected your PC". Choose **More info > Run anyway**.
- The window is drawn by Microsoft Edge WebView2, which comes with Windows 10 and 11.
- The first start after installing takes longer (Windows checks the new files); after that it opens in about two seconds.
- Your data is kept in `%LOCALAPPDATA%\PaperTrader`. Uninstalling (Windows Settings > Apps) leaves it there, so a reinstall keeps your portfolios.

## What you can do

- **Trade:** market, limit and stop orders against live prices, by number of shares or by dollar amount. Each fill prints a receipt.
- **Market hours:**
  - Orders placed while the market is closed wait for the next open, as they would at a broker.
  - Practice mode fills them at once at the last price instead.
  - Limit and stop orders fill even if the app was closed when their price came: the app replays the minutes it missed.
- **Costs:** a commission per order, a commission as a percentage of the order, and slippage. Every rounding goes against you, so the paper ledger can never create money.
- **Charts:**
  - Six chart types, and linear, log or percent scales.
  - Bar sizes from 1 and 5 minutes to hourly, daily and weekly. Minute candles form live from the price stream; Yahoo keeps a week of 1-minute and two months of 5-minute history.
  - Two moving averages, Bollinger bands, volume, RSI and MACD.
  - Your fills, your average cost and your open orders, drawn on the chart.
  - Every choice is remembered.
- **Portfolios:** several of them. A reset keeps the old one as a read-only record. Positions show live profit and loss, the equity curve is compared with SPY, and the trade ledger can be paged, filtered and exported to CSV.
- **Model lab:** change how the model works and test it the honest way, then pick which test drives the live signal.
- **Look:** dark or light, or follow Windows. Up and down colours can be green/red, red/green, or blue/orange for colour-blind eyes. Direction always comes with an arrow and a sign as well.

## How the model is tested, and what it shows

The model is a random forest by default; gradient boosting is the other choice. It guesses whether the next bar closes more than 0.5% up (BUY), more than 0.5% down (SELL), or in between (HOLD). Its inputs, all computed from past bars only:

- the 14-bar RSI
- the gap between the 12- and 26-bar EMAs, as a share of the price
- volume against its own last 20 bars
- the Bollinger %B and band width

It is never tested on a random split, because that would let the future leak into the past.

**Walk-forward validation.** It trains on the past, tests on the next block of bars, and rolls forward, five times. On the same bars it is compared with three simple rules: always the most common outcome, always BUY, and "same as yesterday".

**Backtest.** Buying on its BUY calls is compared with buying and holding over the same days, after a cost on every trade.

**Live record.** The signal you see for each day is stored before the outcome is known, so the live record can't be rewritten by retraining.

On five years of SPY (October 2026), the honest answer was:

| | Balanced accuracy | Return over the tested years |
|---|---|---|
| Random forest | 39.4% | +14.3% |
| Best simple rule | 36.6% | |
| Buy and hold | | +108.3% |

The forest was slightly better than the simple rules at calling direction, but following it earned far less than buying and holding. Gradient boosting showed no edge at all and memorised its training data. The app shows these numbers next to every signal. It is for learning, not for trading real money.

## Run from source

```
py -3.14 -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
cd ui
npm ci
npm run build
cd ..
.venv\Scripts\python -m papertrader serve
```

Then open http://127.0.0.1:8000, or run `.venv\Scripts\python launcher.py` for the desktop window. For UI work with instant reload, keep `serve` running and start `npm run dev` in `ui/`.

Command line:

- `python -m papertrader ingest SPY` downloads five years of daily bars and stores their indicators (`--interval 1h` for hourly).
- `python -m papertrader train SPY` runs the walk-forward test and prints each fold, the baselines and the backtest against buy-and-hold (`--activate` makes it the live model).

The API is documented at http://127.0.0.1:8000/docs.

## Build the installer

`pwsh -File build.ps1` builds the UI, bundles the app with PyInstaller and wraps it with Inno Setup 6 (`winget install JRSoftware.InnoSetup`). The result is `dist\PaperTrader-Setup-<version>.exe`. Pushing a `v*` tag makes GitHub Actions build it and attach it to a release.

## Docker

`docker compose up --build` runs the same app without the desktop window at http://localhost:8000. It only listens on this computer, because the app has no login. Data lives in the `paper-data` volume.

## Layout

| Path | What it does |
|---|---|
| `papertrader/ledger.py` | Portfolios, orders, fills and positions; every change is one all-or-nothing transaction |
| `papertrader/market.py` | Yahoo Finance history in SQLite, symbol checks, New York trading hours |
| `papertrader/features.py` | RSI, EMA spread, volume z-score, Bollinger, MACD, labels; the feature store |
| `papertrader/model.py` | Walk-forward validation, baselines, backtest, live signals |
| `papertrader/worker.py` | Live price stream, order matching on every tick, catch-up after gaps |
| `papertrader/api.py` | FastAPI routes and the WebSocket for live updates |
| `papertrader/desktop.py` | The desktop window around the API |
| `papertrader/schema.sql` | The database |
| `ui/` | The React app (Vite, TypeScript, Tailwind, Lightweight Charts) |
| `tests/` | pytest suite (ledger, market data, features, model, API) |
| `PaperTrader.spec`, `installer.iss`, `build.ps1` | The Windows build |
| `scripts/make_icon.py` | Draws `assets/icon.ico` |

## Data

- Money is stored in whole cents and shares as whole numbers, so no amount goes through floating point.
- Every write runs in a `BEGIN IMMEDIATE` transaction. Two orders can't both spend the same cash, and `CHECK` constraints make negative cash or shares impossible even if the code had a bug.
- The `trades` table is the audit log. Database triggers refuse any change or deletion.
- A position keeps its total cost, not a rounded average, so selling part of it never leaves a few cents behind.
- Bars are split-adjusted, as brokers chart them, and are downloaded again when stale, because Yahoo re-adjusts old bars after a split. Only complete bars are stored.

## Safety

- **Only this computer can reach the app.** Its server answers on 127.0.0.1 only, on a new port each start.
- **Websites can't get in through a trick domain.** A website you visit can't reach it by pointing its own domain at your computer: requests addressed to any other host are refused.
- **Websites can't place orders.** Orders are only accepted as JSON, which browsers don't send across sites without permission, and the app gives none.
- **Websites can't listen to the live updates.** The live-update connection checks which page opened it.
- **Nothing to steal.** There are no passwords, keys or real money in the app, and trained models are never saved as files that could run code when loaded.

## Tests

```
.venv\Scripts\python -m pytest
cd ui
npm test
```

## Credits

- Prices come from Yahoo Finance through [yfinance](https://github.com/ranaroussi/yfinance). Yahoo allows this for personal use, and quotes can be late or missing. The data is never stored in this repository.
- Charts are drawn with [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)&trade;, &copy; TradingView, Inc., under the Apache License 2.0.

Educational software. Not financial advice.
