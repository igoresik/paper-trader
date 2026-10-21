"""Background work: the live price stream, order matching, history refresh and the live signals."""

import asyncio
import base64
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import websockets
from google.protobuf.json_format import MessageToDict
from yfinance.pricing_pb2 import PricingData

from . import db, features, ledger, market, model, settings

log = logging.getLogger("papertrader")
STREAM = "wss://streamer.finance.yahoo.com/?version=2"
SESSIONS = {0: "pre", 1: "regular", 2: "post", 3: "post"}  # Yahoo's market_hours; 0 is left out of messages
FRESH = 15  # seconds a streamed price counts as live for a market order
BUCKET = {"1m": 60, "5m": 300, "1h": 3_600}  # counted from the 09:30 open


def decode(raw):
    """One stream frame to a dict with yfinance's field names."""
    data = PricingData()
    data.ParseFromString(base64.b64decode(json.loads(raw)["message"]))
    return MessageToDict(data, preserving_proto_field_name=True)


class Worker:
    def __init__(self, publish):
        self.publish = publish  # thread-safe hand-off to every open window
        self.quotes = {}  # symbol -> latest quote
        self.minutes = {}  # symbol -> {minute start: [open, high, low, close, volume]} for its latest session
        self.day_volume = {}  # symbol -> the running day volume of its last tick
        self.stream = "connecting"
        self.watched = set()
        self.with_orders = set()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="work")
        # fills get their own thread, so they never queue behind history downloads or model training
        self.matcher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="match")
        self.ticks = {}  # symbol -> ticks waiting for the matcher
        self._ticks_lock = threading.Lock()
        self.split_checked = {}  # symbol -> the day its splits were last checked
        self.loop = None
        self._wake = None
        self._tasks = []

    # lifecycle

    async def start(self):
        self.loop, self._wake = asyncio.get_running_loop(), asyncio.Event()
        self._tasks = [asyncio.create_task(self._housekeeping()), asyncio.create_task(self._stream())]

    async def stop(self):
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.matcher.shutdown(wait=False, cancel_futures=True)

    async def _run(self, fn, *args):
        try:
            return await self.loop.run_in_executor(self.pool, fn, *args)
        except Exception as error:  # one bad symbol or a dropped connection must not stop the loop
            log.warning("%s failed: %s", fn.__name__, error)

    def submit(self, fn, *args, pool=None):
        """Run blocking work in the background, logging what goes wrong."""

        def report(done):
            if not done.cancelled() and (error := done.exception()):
                log.warning("%s failed: %s", fn.__name__, error)

        (pool or self.pool).submit(fn, *args).add_done_callback(report)

    def symbols(self):
        rows = db.query(
            "SELECT symbol FROM watchlist UNION SELECT symbol FROM positions"
            " UNION SELECT symbol FROM orders WHERE status = 'OPEN'"
        )
        return {row["symbol"] for row in rows} | self.watched | {"SPY"}  # SPY is the benchmark

    def watch(self, symbol):
        """Stream this symbol from now on (a new watchlist entry or the chart being looked at)."""
        if symbol not in self.watched:
            self.watched.add(symbol)
            if self.loop:
                self.loop.call_soon_threadsafe(self._wake.set)
                if "price_cents" not in self.quotes.get(symbol, {}):
                    self.submit(self.seed, "1d", [symbol])

    def orders_changed(self):
        self.with_orders = {r["symbol"] for r in db.query("SELECT DISTINCT symbol FROM orders WHERE status = 'OPEN'")}
        if self.loop:
            self.loop.call_soon_threadsafe(self._wake.set)

    def status(self):
        return {"session": market.session(), "stream": self.stream, "live": self.market_live()}

    # history and signals

    async def _housekeeping(self):
        for symbol in sorted(self.symbols()):
            await self._run(self.update_history, symbol)
        await self._run(self.seed, "5d")
        last = None
        while True:
            for symbol in sorted(self.symbols()):
                await self._run(self.update_history, symbol)
            if (now := self.status()) != last:
                self.publish({"type": "status", **now})
                last = now
            await asyncio.sleep(60)

    def update_history(self, symbol):
        """Refresh stale history and make sure the latest complete bar has its signal."""
        self.check_splits(symbol)
        for interval in ("1d", "1h"):
            chosen = model.active(symbol, interval)
            if interval == "1h" and not chosen:
                continue  # hourly history is only kept fresh for symbols with an hourly model
            refreshed = market.needs_refresh(symbol, interval)
            if refreshed:
                market.refresh(symbol, interval)
                self.publish({"type": "history", "symbol": symbol, "interval": interval})
            last = db.query("SELECT MAX(ts) AS ts FROM bars WHERE symbol = ? AND interval = ?", (symbol, interval))[0]["ts"]
            shown = db.query("SELECT 1 FROM signals WHERE symbol = ? AND interval = ? AND ts = ?", (symbol, interval, last))
            if last is not None and (refreshed or not shown):
                try:
                    signal = model.live_signal(symbol, interval)
                except model.ModelError as error:
                    self.publish({"type": "signal", "symbol": symbol, "interval": interval, "error": str(error)})
                    continue
                features.build(symbol, interval, model.Params.load(model.active(symbol, interval)["params"]).indicators)
                self.publish({"type": "signal", **signal})
        self.apply_splits(symbol)  # any a refresh found, here or from a chart

    def check_splits(self, symbol):
        """Once a session, after the open: a split starts at the open, so held shares and open orders move
        to the new share count before the day's prices are matched against them."""
        today = market.day_start(time.time())
        if self.split_checked.get(symbol) == today or market.session() not in ("regular", "post"):
            return
        try:
            market.check_splits(symbol)
        except market.MarketError as error:
            log.warning("split check for %s failed: %s", symbol, error)
            return
        self.split_checked[symbol] = today
        self.apply_splits(symbol)

    def apply_splits(self, symbol):
        changes = ledger.apply_splits(symbol)
        for change in changes:
            self.publish({"type": "split", **change})
        if changes or db.query("SELECT 1 FROM orders WHERE symbol = ? AND status = 'OPEN'", (symbol,)):
            self.orders_changed()

    # prices

    def seed(self, period="1d", symbols=None):
        """Prices and the current session's minutes before the stream says anything, then fill any open orders
        whose price was reached while the app was closed or the stream was down."""
        self.orders_changed()
        bars = market.intraday(sorted(symbols or self.symbols()), period)
        for symbol, rows in bars.items():
            if not rows:
                continue
            day = market.day_start(rows[-1]["ts"])
            today = [r for r in rows if r["ts"] >= day]
            self.minutes[symbol] = {r["ts"]: [r["open"], r["high"], r["low"], r["close"], r["volume"]] for r in today}
            quote = self.quotes.setdefault(symbol, {"symbol": symbol})
            if quote.get("ts", 0) < rows[-1]["ts"]:
                quote.update(price_cents=rows[-1]["close"], ts=rows[-1]["ts"], session="regular")
            quote["prev_close_cents"] = self._prev_close(symbol, day) or next(
                (r["close"] for r in reversed(rows) if r["ts"] < day), None)
            if symbol in self.with_orders:
                self.match(symbol, self._catch_up_bars(symbol, rows))
        self.publish({"type": "quotes", "quotes": list(self.quotes.values())})

    def _prev_close(self, symbol, day):
        rows = db.query(
            "SELECT close_cents FROM bars WHERE symbol = ? AND interval = '1d' AND ts < ? ORDER BY ts DESC LIMIT 1",
            (symbol, day),
        )
        return rows[0]["close_cents"] if rows else None

    def _catch_up_bars(self, symbol, minutes):
        """Daily bars for the days before the minute data starts (Yahoo keeps minutes for about a week)."""
        first = minutes[0]["ts"]
        oldest = db.query("SELECT MIN(created_at) AS t FROM orders WHERE symbol = ? AND status = 'OPEN'", (symbol,))[0]["t"]
        daily = db.query(
            "SELECT ts, open_cents AS open, high_cents AS high, low_cents AS low, close_cents AS close FROM bars"
            " WHERE symbol = ? AND interval = '1d' AND ts >= ? AND ts < ? ORDER BY ts",
            (symbol, market.day_start(oldest or first), market.day_start(first)),
        )
        return daily + minutes

    def match(self, symbol, bars):
        events = ledger.match(symbol, bars, settings.costs())
        for event in events:
            self.publish({"type": "fill" if "price_cents" in event else "rejected", **event})
        if events:
            self.orders_changed()

    def market_live(self):
        """Regular session with SPY trading in the last few minutes, which holidays and halts don't have."""
        spy = self.quotes.get("SPY", {})
        return market.session() == "regular" and spy.get("session") == "regular" and time.time() - spy.get("ts", 0) < 180

    def fresh_price(self, symbol):
        """A regular-session price at most FRESH seconds old, or None when the market isn't trading."""
        quote = self.quotes.get(symbol, {})
        if quote.get("session") == "regular" and time.time() - quote.get("ts", 0) <= FRESH:
            return quote["price_cents"]
        if market.session() != "regular":
            return None
        rows = market.intraday([symbol]).get(symbol) or []
        if not rows or time.time() - rows[-1]["ts"] > 180:
            return None
        self.quotes.setdefault(symbol, {"symbol": symbol}).update(
            price_cents=rows[-1]["close"], ts=rows[-1]["ts"], session="regular")
        return rows[-1]["close"]

    def price(self, symbol):
        """The latest regular-session price we know, falling back to the last stored close."""
        if price := self.quotes.get(symbol, {}).get("price_cents"):
            return price
        rows = db.query("SELECT close_cents FROM bars WHERE symbol = ? AND interval = '1d' ORDER BY ts DESC LIMIT 1",
                        (symbol,))
        return rows[0]["close_cents"] if rows else None

    def prev_close(self, symbol):
        return self.quotes.get(symbol, {}).get("prev_close_cents")

    def day_start(self):
        """Start of the session the prices belong to: today while it trades, the last session until the next opens."""
        spy = self.minutes.get("SPY")
        return market.day_start(max(spy)) if spy else market.day_start(time.time())

    def session_bars(self, symbol, interval):
        """The latest session's minutes grouped into bars of this interval (1m, 5m or 1h), oldest first."""
        minutes = self.minutes.get(symbol)
        if not minutes:
            return []
        size, opened = BUCKET[interval], market.session_open(max(minutes))
        groups = {}
        for ts in sorted(minutes):
            groups.setdefault(opened + (ts - opened) // size * size, []).append(minutes[ts])
        return [_merge(start, parts) for start, parts in groups.items()]

    def live_bar(self, symbol, interval):
        """The bar still forming, built from the session's minutes, or None."""
        if interval == "1d":
            minutes = self.minutes.get(symbol)
            return _merge(market.day_start(max(minutes)), [minutes[ts] for ts in sorted(minutes)]) if minutes else None
        bars = self.session_bars(symbol, interval)
        return bars[-1] if bars else None

    # the stream

    async def _stream(self):
        delay = 1
        while True:
            try:
                async with websockets.connect(STREAM, open_timeout=15, ping_interval=20) as ws:
                    self._set_stream("live")
                    delay = 1
                    beat = asyncio.create_task(self._subscribe(ws))
                    try:
                        async for raw in ws:
                            self._tick(decode(raw))
                    finally:
                        beat.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.warning("price stream dropped: %s", error)
            self._set_stream("reconnecting")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
            await self._run(self.seed)  # orders whose price was reached during the gap

    async def _subscribe(self, ws):
        while True:
            await ws.send(json.dumps({"subscribe": sorted(self.symbols())}))
            self._wake.clear()
            try:  # Yahoo forgets symbols that aren't sent again about every 15 s
                await asyncio.wait_for(self._wake.wait(), 15)
            except TimeoutError:
                pass

    def _set_stream(self, state):
        if state != self.stream:
            self.stream = state
            self.publish({"type": "status", **self.status()})

    def _tick(self, msg):
        symbol, price = msg.get("id"), msg.get("price")
        if not symbol or not price:
            return
        ts = int(msg.get("time", 0)) // 1000 or int(time.time())
        session = SESSIONS.get(msg.get("market_hours", 0), "post")
        cents = market.cents(price)
        quote = self.quotes.setdefault(symbol, {"symbol": symbol})
        if session == "regular":
            quote.update(price_cents=cents, ts=ts, session="regular", ext_price_cents=None)
            traded = 0
            if (total := msg.get("day_volume")) is not None:  # a running total, so each tick adds the difference
                total = int(total)
                traded = max(0, total - self.day_volume.get(symbol, total))
                self.day_volume[symbol] = total
            self._add_minute(symbol, ts, cents, traded)
            if symbol in self.with_orders:
                self._queue_tick(symbol, {"ts": ts, "open": cents, "high": cents, "low": cents, "close": cents})
        else:
            quote.update(ext_price_cents=cents, ext_session=session)
            if quote.get("session") == "regular" and market.session(ts) != "regular":
                quote["session"] = "closed"
        self.publish({"type": "quote", **quote})

    def _queue_tick(self, symbol, tick):
        """One match per symbol at a time: ticks that arrive meanwhile are matched together next, so they can't pile up."""
        with self._ticks_lock:
            waiting = symbol in self.ticks
            self.ticks.setdefault(symbol, []).append(tick)
        if not waiting:
            self.submit(self._match_ticks, symbol, pool=self.matcher)

    def _match_ticks(self, symbol):
        self.check_splits(symbol)
        with self._ticks_lock:
            ticks = self.ticks.pop(symbol, [])
        if ticks:
            self.match(symbol, ticks)

    def _add_minute(self, symbol, ts, cents, volume=0):
        minutes = self.minutes.setdefault(symbol, {})
        if minutes and market.day_start(max(minutes)) != market.day_start(ts):
            minutes.clear()  # a new session
        start = ts - ts % 60
        if bar := minutes.get(start):
            bar[1], bar[2], bar[3], bar[4] = max(bar[1], cents), min(bar[2], cents), cents, bar[4] + volume
        else:
            minutes[start] = [cents, cents, cents, cents, volume]


def _merge(ts, parts):
    """One bar from consecutive [open, high, low, close, volume] parts."""
    return {"ts": ts, "open": parts[0][0], "high": max(p[1] for p in parts), "low": min(p[2] for p in parts),
            "close": parts[-1][3], "volume": sum(p[4] for p in parts)}
