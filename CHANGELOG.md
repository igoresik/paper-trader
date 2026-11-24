# Changelog

## Unreleased

New since 1.4.1:

- **Discover.** A new view to find something to trade without knowing its ticker: about 150 US stocks and ETFs in twelve categories (big tech, AI and chips, banks, health, cars, dividend payers, ETFs and more), each with its price, today's, 1-month and 1-year change and a month-long chart. Filter by name, show only stocks or ETFs, sort by popularity, gainers, losers, 1 month or 1 year, add to the watchlist or open the chart in one click. Symbols you watch show the model's call.

Fixes since 1.4.1:

- **Live fills show up.** A limit, stop or queued market order that filled in the background, and orders placed or cancelled from another window, now refresh the portfolio and show a notice. The order's own type had replaced the kind of event, so the window ignored them.
- **Splits.** A reverse split's leftover fraction is paid at the new price even before the history has been re-downloaded (a half share after a 1-for-10 split was paid at a tenth of its value). A failed split check waits a minute before trying again and no longer holds up fills.
- **Yahoo gaps.** An empty answer from Yahoo no longer wipes the stored prices, the VIX or the yield. The app asks again after five minutes instead of on every click, and retries the yield download when only that one failed. Bars with a missing open, high or low are skipped instead of stopping the refresh. A failing symbol search turns on the Yahoo down banner like the other calls.
- **Orders.** Limit and stop orders say they wait while the market is closed, like market orders already did.
- **Charts and report card.** The equity curve and report card no longer fail when a first value or first close is zero. Drawdown starts from the starting cash, and the backtest drawdown counts a loss on the first bar. A day with no bar keeps the last close instead of valuing a holding at zero.
- **Replay.** Closing a replay twice no longer changes when it closed, and stepping a closed one says so. Replay orders have the same size and price limits as live ones. Cancel and close show their errors, and a replay whose prices are gone says that instead of crashing. Closing a replay by a live portfolio's id no longer cancels its orders.
- **Portfolios and watchlist.** Removing a symbol, or resetting a portfolio, stops streaming prices for it. A reset portfolio can't be picked as the active one.
- **Models.** Two first signals at once no longer train two models. The backtest says it scores the next bar, even for barrier calls. Settings for charts and the lab are capped at 20 KB.
- **Safety.** The app stops with a clear message if the database comes from a newer version.
- Behind the scenes: tests also run on Python 3.12, the command line's `train` takes the same horizon and downloads the same context as the app, `ingest` says when a symbol has too few bars, and the README and build script notes match the versions CI uses.

## 1.4.1 (2026-11-03)

- The installer is now built on Python 3.15 and Node 26, and the Docker image runs on them too.
- Newer FastAPI (0.162) and pandas (3.1) inside, and newer TanStack Query and Lucide icons in the window. No new features.
- Behind the scenes: CI tests on Python 3.15 and Node 26 and builds the installer on every pull request, so a broken build shows up before a release. Newer Vite, pytest and httpx2. The README now has the real Python and Node versions, Mac and Linux setup, an architecture diagram and the design decisions.

## 1.4.0 (2026-10-22)

- Model lab tests a third strategy, **calm before big moves**: hold less when the move reading expects a bigger move than usual, scored against holding the same average amount. The chart switches between the model's calls, lean sizing and calm, each next to its own same-size line.

## 1.3.1 (2026-10-22)

- The window opens maximized, or, if you last closed it smaller, centered on the screen at a size that fits. It used to open off to the side.

## 1.3.0 (2026-10-22)

- Short selling: with no shares held, Sell becomes **Sell short**, and **Buy back** closes it. The sale's money plus half as much again is held as collateral, and if the price rises until that collateral is only 130% of the cost of buying back, the app buys the short back for you, even after it was closed.
- Before it upgrades your data, the app saves a copy of the old database next to it.
- The report card counts buy-backs as closed trades.
- Behind the scenes: tests for the order ticket, signal card and report tiles, Dependabot watching the dependencies, a newer Pillow for the icon script, and a worker test that failed now and then fixed.

## 1.2.1 (2026-10-21)

- A Buy or Sell call now also has to beat how often its direction came anyway on the days that moved. SPY went up on about 54% of them, so Buy calls that were right 55% of the time no longer show as a clear call.

## 1.2.0 (2026-10-21)

- New runs also read the volatility regime: the last 5 days' swings against the last 60's, and the latest 1- and 5-day moves measured in those swings.
- Model lab can drop inputs that don't help. Each training window picks its own, from how much shuffling each one hurts its last fifth, so the bars it's tested on never choose them.
- The Model lab backtest also sizes by the model's lean, holding half to all of the money, and scores that against holding the same average amount all the time.
- Model lab can test a first-barrier call: which the close reaches first within 2 to 20 bars, up or down by a volatility-sized barrier, or neither. The bars whose labels look into each test block are left out of its training, and overlapping calls count once per stretch when judging them.

## 1.1.0 (2026-10-21)

- The signal card says **No clear edge** when a call hasn't beaten how often that outcome happens anyway, and the watchlist badge goes grey.
- The model's verdict comes from a likely range for its edge, which widens with every Model lab run on the same data.
- A report card for you on the Portfolio page: sales that made money, average win and loss, biggest drop, costs paid including slippage, time in the market, and SPY and SPY's model over the same days.
- History replay: trade a symbol's past one day at a time, scored against buying and holding and against the model's out-of-sample calls.
- A banner when Yahoo Finance can't be reached, and an optional check for new versions on GitHub.
- Models train on all of a symbol's daily history (SPY from 1993) instead of five years, and new runs also read the VIX, the 10-year yield and 5- and 20-day moves.
- A move reading next to the signal: whether the next bar moves more than usual, with its own out-of-sample test and live record. Model lab also scores up against down alone.
- A Buy or Sell call now has to get the direction right on days that moved, not just beat how often that kind of day comes; Hold is left to the move reading.
- MIT license.

## 1.0.0 (2026-10-21)

- First release: paper trading with market, limit and stop orders on live US prices, charts from 1-minute to weekly bars, several portfolios, the walk-forward-tested model and Model lab, the Windows installer and the Docker image.
- Fixed before release: stock splits now move held shares and open orders, ticks are matched on their own thread, changes sent from other websites are refused, and smaller fixes from code and security reviews.
