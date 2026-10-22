# Changelog

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
