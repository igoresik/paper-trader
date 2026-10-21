from datetime import datetime

import numpy as np
import pandas as pd
import pytest

from papertrader import db, market
from papertrader.market import NY

SPY = {"currency": "USD", "instrumentType": "ETF", "longName": "SPDR S&P 500 ETF Trust", "fullExchangeName": "NYSEArca"}


class FakeTicker:
    def __init__(self, frame, meta):
        self.frame, self.history_metadata = frame, meta

    def history(self, **kw):
        return self.frame


def ny(*parts):
    return int(datetime(*parts, tzinfo=NY).timestamp())


def daily(days, closes):
    index = pd.DatetimeIndex([pd.Timestamp(day, tz=NY) for day in days])
    return pd.DataFrame(
        {"Open": closes, "High": [c + 1 for c in closes], "Low": [c - 1 for c in closes], "Close": closes,
         "Volume": [1_000_000] * len(closes)},
        index=index,
    )


def serve(monkeypatch, frame, meta=SPY):
    monkeypatch.setattr(market, "_ticker", lambda symbol: FakeTicker(frame, meta))


def closes():
    return [r["close_cents"] for r in db.query("SELECT close_cents FROM bars ORDER BY ts")]


def test_refresh_stores_cents_and_leaves_out_the_bar_still_trading(monkeypatch):
    serve(monkeypatch, daily(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"], [773.23999, 10.005, 101.0, 102.0]))
    assert market.refresh("spy", "1d", now=ny(2026, 10, 16, 15)) == 3  # Friday 15:00, still trading
    assert closes() == [77_324, 1_001, 10_100]
    assert db.query("SELECT symbol, name, kind FROM symbols") == [
        {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "kind": "ETF"}
    ]


def test_refresh_keeps_the_splits_yahoo_marks(monkeypatch):
    serve(monkeypatch, daily(["2026-10-13", "2026-10-14"], [100.0, 101.0]).assign(**{"Stock Splits": [0.0, 10.0]}))
    market.refresh("SPY", "1d", now=ny(2026, 10, 20, 12))
    hourly = pd.DataFrame({"Open": [101.0], "High": [102.0], "Low": [100.0], "Close": [101.0], "Volume": [1_000],
                           "Stock Splits": [10.0]}, index=pd.DatetimeIndex([pd.Timestamp("2026-10-14 09:30", tz=NY)]))
    serve(monkeypatch, hourly)
    market.refresh("SPY", "1h", now=ny(2026, 10, 20, 12))  # the same split, on the day's first hour
    assert db.query("SELECT symbol, ts, ratio FROM splits") == [{"symbol": "SPY", "ts": ny(2026, 10, 14), "ratio": 10.0}]
    factor = market.split_factor("SPY")
    assert (factor(ny(2026, 10, 13, 15)), factor(ny(2026, 10, 14))) == (10.0, 1)


def test_refresh_replaces_the_old_bars(monkeypatch):
    serve(monkeypatch, daily(["2026-10-13", "2026-10-14"], [200.0, 202.0]))
    market.refresh("SPY", "1d", now=ny(2026, 10, 20, 12))
    serve(monkeypatch, daily(["2026-10-13", "2026-10-14"], [100.0, 101.0]))  # after a 2-for-1 split
    market.refresh("SPY", "1d", now=ny(2026, 10, 20, 12))
    assert closes() == [10_000, 10_100]


@pytest.mark.parametrize(
    "meta", [{"currency": "EUR", "instrumentType": "EQUITY"}, {"currency": "USD", "instrumentType": "CRYPTOCURRENCY"}]
)
def test_only_dollar_stocks_and_etfs_are_accepted(monkeypatch, meta):
    serve(monkeypatch, daily(["2026-10-13"], [10.0]), meta)
    with pytest.raises(market.NotTradable, match="only US stocks and ETFs"):
        market.refresh("SAP", "1d", now=ny(2026, 10, 20, 12))
    assert closes() == []


def test_symbols_are_checked_before_asking_yahoo():
    with pytest.raises(market.UnknownSymbol, match="isn't a ticker symbol"):
        market.refresh("not a ticker", "1d")


def test_bars_count_as_complete_once_settled_after_they_end():
    monday = ny(2026, 10, 19)
    assert not market.is_complete(monday, "1d", ny(2026, 10, 19, 16, 5))
    assert market.is_complete(monday, "1d", ny(2026, 10, 19, 16, 10))
    assert market.is_complete(ny(2026, 10, 19, 15, 30), "1h", ny(2026, 10, 19, 16, 10))  # last hour bar is 30 min


def test_history_goes_stale_after_each_close(monkeypatch):
    serve(monkeypatch, daily(["2026-10-15"], [10.0]))
    market.refresh("SPY", "1d", now=ny(2026, 10, 16, 17))  # Friday evening
    assert not market.needs_refresh("SPY", "1d", now=ny(2026, 10, 18, 12))  # Sunday: nothing new
    assert market.needs_refresh("SPY", "1d", now=ny(2026, 10, 19, 16, 11))  # Monday after the close
    assert market.needs_refresh("QQQ", "1d")  # never fetched


def test_frame_gives_dollars_by_bar_start(monkeypatch):
    serve(monkeypatch, daily(["2026-10-13", "2026-10-14"], [100.5, 101.25]))
    market.refresh("SPY", "1d", now=ny(2026, 10, 20, 12))
    bars = market.frame("SPY", "1d")
    assert bars["close"].tolist() == [100.5, 101.25]
    assert bars.index[0] == ny(2026, 10, 13)


def test_market_context_is_lined_up_without_looking_ahead(monkeypatch):
    days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]
    frames = {"^VIX": daily(days, [10.0 + i for i in range(8)]), "^TNX": daily(days, [4.0 + i / 10 for i in range(8)])}
    monkeypatch.setattr(market, "_ticker", lambda symbol: FakeTicker(frames[symbol], {}))
    market.refresh_context(now=ny(2026, 10, 8, 12))
    starts = [ny(2026, 9, 28), ny(2026, 10, 7)]
    by_day = market.context(starts, "1d")
    assert list(by_day["vix"]) == [10.0, 17.0]  # a daily bar sees that day's close
    assert by_day["yield_change"].iloc[1] == pytest.approx(0.5)  # 4.7% against 4.2% five days before
    by_hour = market.context([ny(2026, 10, 7, 10), ny(2026, 9, 28, 10)], "1h")
    assert by_hour["vix"].iloc[0] == 16.0 and np.isnan(by_hour["vix"].iloc[1])  # an hour only sees the day before


def test_context_is_left_out_until_it_has_been_downloaded():
    assert market.context([ny(2026, 10, 7)], "1d") is None


def test_a_series_yahoo_did_not_send_is_left_out(monkeypatch):
    days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"]

    class TimedOut:
        def history(self, **kw):
            raise ConnectionError("timed out")

    def ticker(symbol):
        return TimedOut() if symbol == "^VIX" else FakeTicker(daily(days, [4.0 + i / 10 for i in range(6)]), {})

    monkeypatch.setattr(market, "_ticker", ticker)
    with pytest.raises(market.MarketError):
        market.refresh_context(now=ny(2026, 10, 8, 12))
    assert list(market.context([ny(2026, 10, 5)], "1d").columns) == ["yield_change"]  # the yield still arrived
