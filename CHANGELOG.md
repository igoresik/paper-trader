# Changelog

## 1.1.0 (not released yet)

- The signal card says **No clear edge** when a call hasn't beaten how often that outcome happens anyway, and the watchlist badge goes grey.
- The model's verdict comes from a likely range for its edge, which widens with every Model lab run on the same data.
- A report card for you on the Portfolio page: sales that made money, average win and loss, biggest drop, costs paid including slippage, time in the market, and SPY and SPY's model over the same days.
- History replay: trade a symbol's past one day at a time, scored against buying and holding and against the model's out-of-sample calls.
- A banner when Yahoo Finance can't be reached, and an optional check for new versions on GitHub.
- MIT license.

## 1.0.0 (2026-10-21)

- First release: paper trading with market, limit and stop orders on live US prices, charts from 1-minute to weekly bars, several portfolios, the walk-forward-tested model and Model lab, the Windows installer and the Docker image.
- Fixed before release: stock splits now move held shares and open orders, ticks are matched on their own thread, changes sent from other websites are refused, and smaller fixes from code and security reviews.
