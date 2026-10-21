"""Market data from Yahoo Finance (via yfinance): history cached in SQLite, symbol checks and New York trading hours."""

import logging
import math
import re
import time
from datetime import datetime, timedelta
from datetime import time as clock
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf
from yfinance import exceptions as yfe

from . import db

NY = ZoneInfo("America/New_York")
CLOSE = clock(16, 0)
SETTLE = 600  # Yahoo finalises a bar a few minutes after it ends
# all the daily history there is: a model tested on 30 years of SPY did better in recent years too than one on 5;
# 730 days is as far back as Yahoo serves hourly bars
PERIODS = {"1d": "max", "1h": "730d"}
SYMBOL = re.compile(r"[A-Z][A-Z0-9.\-]{0,9}")
OFFLINE = "Can't reach Yahoo Finance. Check the internet connection."
logging.getLogger("yfinance").setLevel(logging.CRITICAL)  # its errors resurface as MarketError messages


_heard = {"answered": 0.0, "failed": 0.0}  # when Yahoo last answered, and when a request last failed


def _answered():
    _heard["answered"] = time.time()


def _failed():
    _heard["failed"] = time.time()


def yahoo_down():
    """The latest request to Yahoo failed, in the last ten minutes."""
    return _heard["failed"] > _heard["answered"] and time.time() - _heard["failed"] < 600


class MarketError(Exception):
    """A market data problem, written for the user."""

    status = 503
    code = "market_data"


class UnknownSymbol(MarketError):
    status = 404
    code = "unknown_symbol"


class NotTradable(MarketError):
    status = 400
    code = "not_tradable"


def cents(price):
    """Yahoo's float dollars to whole cents, rounded half up as the price is written."""
    return int(Decimal(repr(float(price))).quantize(Decimal("0.01"), ROUND_HALF_UP) * 100)


def clean(symbol):
    symbol = symbol.strip().upper()
    if not SYMBOL.fullmatch(symbol):
        raise UnknownSymbol(f"{symbol or 'That'} isn't a ticker symbol.")
    return symbol


def _ticker(symbol):  # swapped for a fake in tests
    return yf.Ticker(symbol)


def _history(ticker, symbol, **kw):
    try:
        frame = ticker.history(raise_errors=True, **kw)
    except (yfe.YFPricesMissingError, yfe.YFTickerMissingError, yfe.YFTzMissingError):
        _answered()  # Yahoo is fine; it just has nothing for this symbol
        raise UnknownSymbol(f"No market data found for {symbol}.") from None
    except yfe.YFRateLimitError:
        _failed()
        raise MarketError("Yahoo Finance is limiting requests right now. Try again in a minute.") from None
    except Exception as error:  # network trouble arrives as many exception types
        _failed()
        raise MarketError(OFFLINE) from error
    _answered()
    return frame


def _tradable(symbol, meta):
    kind, currency = meta.get("instrumentType"), meta.get("currency")
    if kind not in ("EQUITY", "ETF") or currency != "USD":
        raise NotTradable(f"{symbol} can't be traded here: only US stocks and ETFs priced in dollars are supported.")
    return {
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "kind": kind,
        "currency": currency,
    }


# trading hours


def session(now=None):
    """pre, regular, post or closed, by the New York clock (holidays show up as no fresh prices instead)."""
    local = datetime.fromtimestamp(now or time.time(), NY)
    at = local.time()
    if local.weekday() >= 5 or not clock(4) <= at < clock(20):
        return "closed"
    return "pre" if at < clock(9, 30) else "regular" if at < CLOSE else "post"


def day_start(ts):
    """Midnight New York time on the day ts falls on: daily bars start there."""
    return int(datetime.combine(datetime.fromtimestamp(ts, NY).date(), clock(0), NY).timestamp())


def session_open(ts):
    return int(datetime.combine(datetime.fromtimestamp(ts, NY).date(), clock(9, 30), NY).timestamp())


def session_close(ts):
    """16:00 New York time on the day ts falls on."""
    return int(datetime.combine(datetime.fromtimestamp(ts, NY).date(), CLOSE, NY).timestamp())


def is_complete(ts, interval, now):
    end = min(ts + (3_600 if interval == "1h" else 86_400), session_close(ts))
    return now >= end + SETTLE


def last_bar_end(interval, now):
    """The latest weekday moment, at least SETTLE ago, at which a bar of this interval ended."""
    local = datetime.fromtimestamp(now - SETTLE, NY)
    ends = [CLOSE] if interval == "1d" else [clock(hour, 30) for hour in range(10, 16)] + [CLOSE]
    for back in range(7):
        day = local.date() - timedelta(days=back)
        if day.weekday() < 5:
            for end in reversed(ends):
                moment = datetime.combine(day, end, NY)
                if moment <= local:
                    return int(moment.timestamp())
    raise AssertionError("there is always a weekday within 7 days")


# history


def needs_refresh(symbol, interval, now=None):
    now = now or int(time.time())
    rows = db.query("SELECT fetched_at FROM fetches WHERE symbol = ? AND interval = ?", (symbol, interval))
    return not rows or rows[0]["fetched_at"] < last_bar_end(interval, now) + SETTLE


def refresh(symbol, interval="1d", now=None):
    """Download the whole history again, because Yahoo re-adjusts old bars after a split,
    and store the bars that are complete. Returns how many were stored."""
    symbol, now = clean(symbol), now or int(time.time())
    ticker = _ticker(symbol)
    frame = _history(ticker, symbol, period=PERIODS[interval], interval=interval, auto_adjust=False, actions=True)
    info = _tradable(symbol, ticker.history_metadata or {})
    rows = [
        (symbol, interval, ts, cents(r.Open), cents(r.High), cents(r.Low), cents(r.Close), int(r.Volume))
        for r in frame.itertuples()
        if is_complete(ts := int(r.Index.timestamp()), interval, now) and not pd.isna(r.Close) and not pd.isna(r.Volume)
    ]
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO symbols (symbol, name, exchange, kind, currency) VALUES (:symbol, :name, :exchange, :kind, :currency)"
            " ON CONFLICT (symbol) DO UPDATE SET name = excluded.name, exchange = excluded.exchange,"
            " kind = excluded.kind, currency = excluded.currency",
            info,
        )
        conn.execute("DELETE FROM bars WHERE symbol = ? AND interval = ?", (symbol, interval))
        conn.executemany("INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        _keep_splits(conn, symbol, frame)
        conn.execute(
            "INSERT INTO fetches VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at",
            (symbol, interval, now),
        )
    return len(rows)


def _keep_splits(conn, symbol, frame):
    """Yahoo marks a split on the first bar at the new price; it's stored once, by that day's start."""
    if "Stock Splits" in frame:
        conn.executemany(
            "INSERT OR IGNORE INTO splits (symbol, ts, ratio) VALUES (?, ?, ?)",
            [(symbol, day_start(int(at.timestamp())), float(ratio))
             for at, ratio in frame["Stock Splits"].items() if ratio and not pd.isna(ratio)],
        )


def check_splits(symbol):
    """The last few days' splits. A split takes effect at the open, long before that day's bar is complete."""
    frame = _history(_ticker(symbol), symbol, period="5d", interval="1d", auto_adjust=False, actions=True)
    with db.tx() as conn:
        _keep_splits(conn, symbol, frame)


def split_factor(symbol):
    """factor(ts): how many shares one share held at ts has become, from the splits since (10 after a 10-for-1)."""
    splits = db.query("SELECT ts, ratio FROM splits WHERE symbol = ?", (symbol,))
    return lambda ts: math.prod(s["ratio"] for s in splits if s["ts"] > ts)


# the market's fear gauge and the 10-year Treasury yield: index levels, not tradable, so kept apart from symbols
CONTEXT = ("^VIX", "^TNX")


def refresh_context(now=None):
    """Download the context series' daily history, stored as bars by New York day start like every daily bar."""
    now, failed = now or int(time.time()), None
    for symbol in CONTEXT:
        try:  # one series failing shouldn't hold the other back
            frame = _history(_ticker(symbol), symbol, period=PERIODS["1d"], interval="1d", auto_adjust=False)
        except MarketError as error:
            failed = error
            continue
        # the VIX starts in 1990; older yields aren't needed, and Windows can't place dates before 1970
        frame = frame[frame.index >= pd.Timestamp("1990-01-01", tz=frame.index.tz)]
        days = {}
        for r in frame.itertuples():
            day = day_start(int(r.Index.timestamp()))
            if is_complete(day, "1d", now) and not pd.isna(r.Close):
                days[day] = (symbol, "1d", day, cents(r.Open), cents(r.High), cents(r.Low), cents(r.Close), 0)
        with db.tx() as conn:
            conn.execute("DELETE FROM bars WHERE symbol = ? AND interval = '1d'", (symbol,))
            conn.executemany("INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)", list(days.values()))
            conn.execute(
                "INSERT INTO fetches VALUES (?, '1d', ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at",
                (symbol, now),
            )
    if failed:
        raise failed


def context(index, interval):
    """The VIX, its 5-day change and the yield's 5-day change as known at each bar: a daily bar sees that day's
    close, an hourly bar only the day before's. None when the series haven't been downloaded."""
    rows = db.query("SELECT symbol, ts, close_cents FROM bars WHERE interval = '1d' AND symbol IN (?, ?) ORDER BY ts",
                    CONTEXT)
    if not rows:
        return None
    daily = pd.DataFrame(rows).pivot(index="ts", columns="symbol", values="close_cents").reindex(columns=list(CONTEXT))
    daily = daily.ffill() / 100
    table = pd.DataFrame({"vix": daily["^VIX"], "vix_change": np.log(daily["^VIX"]).diff(5),
                          "yield_change": daily["^TNX"].diff(5)}).dropna(axis=1, how="all")  # a series not downloaded
    known = np.array([day_start(int(ts)) - (0 if interval == "1d" else 1) for ts in index])
    at = np.searchsorted(table.index.to_numpy(), known, side="right") - 1
    values = table.to_numpy()[np.maximum(at, 0)]
    values[at < 0] = np.nan
    return pd.DataFrame(values, index=index, columns=table.columns)


def frame(symbol, interval, since=0):
    """Stored bars as a DataFrame indexed by bar start (unix s), prices in dollars."""
    rows = db.query(
        "SELECT ts, open_cents, high_cents, low_cents, close_cents, volume FROM bars"
        " WHERE symbol = ? AND interval = ? AND ts >= ? ORDER BY ts",
        (symbol, interval, since),
    )
    bars = pd.DataFrame(rows, columns=["ts", "open_cents", "high_cents", "low_cents", "close_cents", "volume"])
    bars = bars.set_index("ts")
    for col in ("open", "high", "low", "close"):
        bars[col] = bars.pop(f"{col}_cents") / 100
    bars["volume"] = bars.pop("volume").astype(float)
    return bars


def intraday(symbols, period="1d", interval="1m"):
    """Regular-session bars shorter than a day (1m keeps about a week, 5m about two months) per symbol, in cents,
    oldest first. Symbols Yahoo has nothing for are left out."""
    try:
        data = yf.download(symbols, period=period, interval=interval, group_by="ticker", auto_adjust=False,
                           prepost=False, progress=False, threads=True)
    except Exception as error:
        _failed()
        raise MarketError(OFFLINE) from error
    _answered()
    found = {}
    for symbol in set(symbols) & set(data.columns.get_level_values(0)):
        rows = data[symbol].dropna(subset=["Close"])
        found[symbol] = [
            {"ts": int(r.Index.timestamp()), "open": cents(r.Open), "high": cents(r.High), "low": cents(r.Low),
             "close": cents(r.Close), "volume": 0 if pd.isna(r.Volume) else int(r.Volume)}
            for r in rows.itertuples()
        ]
    return found


def search(query, limit=8):
    """US stocks and ETFs matching a name or ticker. Other markets' listings carry a suffix (SAP.DE), so they are left out."""
    try:
        quotes = yf.Search(query, max_results=limit * 2, news_count=0).quotes
    except Exception as error:
        raise MarketError(OFFLINE) from error
    found = [
        {"symbol": q["symbol"], "name": q.get("shortname") or q.get("longname") or q["symbol"], "kind": q["quoteType"]}
        for q in quotes
        if q.get("quoteType") in ("EQUITY", "ETF") and "." not in q.get("symbol", ".")
    ]
    return found[:limit]
