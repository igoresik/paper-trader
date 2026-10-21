"""HTTP and WebSocket API. Swagger docs are served at /docs."""

import asyncio
import csv
import io
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import __version__, db, features, ledger, market, model, settings
from .worker import Worker

Side = Literal["BUY", "SELL"]
Cents = Annotated[int, Field(gt=0, le=10**12)]
Shares = Annotated[int, Field(gt=0, le=10**7)]
Name = Annotated[str, Field(min_length=1, max_length=40)]
DAYS_BACK = {"1m": 31, "3m": 92, "6m": 183, "1y": 366, "2y": 731, "5y": 1_827}
# ranges a minute chart can show, as Yahoo's period names: 1-minute bars go back a week, 5-minute about two months
MINUTE_RANGES = {"1m": {"1d": "1d", "5d": "5d"}, "5m": {"5d": "5d", "1m": "1mo"}}


class AccountIn(BaseModel):
    name: Name
    starting_cash_cents: Cents


class RenameIn(BaseModel):
    name: Name


class ResetIn(BaseModel):
    starting_cash_cents: Cents | None = None


class MarketOrderIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"account_id": 1, "symbol": "AAPL", "side": "BUY", "shares": 10}]})
    account_id: int
    symbol: str
    side: Side
    shares: Shares


class OrderIn(MarketOrderIn):
    type: Literal["LIMIT", "STOP"]
    limit_cents: Cents | None = None
    stop_cents: Cents | None = None


class WatchIn(BaseModel):
    symbol: str


class ReorderIn(BaseModel):
    symbols: list[str]


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commission_cents: Annotated[int, Field(ge=0, le=10_000)] | None = None
    commission_bps: Annotated[int, Field(ge=0, le=500)] | None = None
    slippage_bps: Annotated[int, Field(ge=0, le=500)] | None = None
    practice_mode: bool | None = None
    confirm_orders: bool | None = None
    theme: Literal["system", "dark", "light"] | None = None
    updown: Literal["green-red", "red-green", "blue-orange"] | None = None
    account_id: int | None = None
    chart: dict | None = None
    lab: dict | None = None


class IndicatorsIn(BaseModel):
    rsi: Annotated[int, Field(ge=2, le=100)] = 14
    ema_fast: Annotated[int, Field(ge=2, le=200)] = 12
    ema_slow: Annotated[int, Field(ge=3, le=400)] = 26
    bb: Annotated[int, Field(ge=2, le=200)] = 20
    bb_k: Annotated[float, Field(gt=0, le=5)] = 2.0
    vol: Annotated[int, Field(ge=2, le=200)] = 20

    @model_validator(mode="after")
    def fast_below_slow(self):
        if self.ema_fast >= self.ema_slow:
            raise ValueError("The fast EMA has to be shorter than the slow one.")
        return self


class RunIn(BaseModel):
    interval: Literal["1d", "1h"] = "1d"
    threshold: Annotated[float, Field(gt=0, le=0.1)] = 0.005
    estimator: Literal["random_forest", "gradient_boosting"] = "random_forest"
    trees: Annotated[int, Field(ge=10, le=1_000)] = 200
    max_depth: Annotated[int, Field(ge=1, le=20)] = 3
    learning_rate: Annotated[float, Field(gt=0, le=1)] = 0.05
    min_leaf: Annotated[int, Field(ge=1, le=500)] = 20
    folds: Annotated[int, Field(ge=2, le=10)] = 5
    min_confidence: Annotated[float, Field(ge=0, lt=1)] = 0.0
    cost_bps: Annotated[float, Field(ge=0, le=500)] = 5.0
    indicators: IndicatorsIn = IndicatorsIn()


class Hub:
    """Fan-out of live events to every open window. publish() may be called from any thread."""

    def __init__(self):
        self.loop, self.queues = None, set()

    def publish(self, event):
        if self.loop:
            self.loop.call_soon_threadsafe(self._put, event)

    def _put(self, event):
        for queue in self.queues:
            if not queue.full():  # a stalled window misses updates rather than filling memory
                queue.put_nowait(event)


def _since(span, now=None):
    now = now or time.time()
    if span == "ytd":
        return market.day_start(datetime(datetime.fromtimestamp(now, market.NY).year, 1, 1, tzinfo=market.NY).timestamp())
    if span == "all":
        return 0
    if span not in DAYS_BACK:
        raise HTTPException(422, f"Range must be one of {', '.join([*DAYS_BACK, 'ytd', 'all'])}.")
    return int(now) - DAYS_BACK[span] * 86_400


def _numbers(spec, count, example, periods):
    """'20:2' -> [20.0, 2.0]; an empty spec turns the indicator off. The first `periods` values count bars."""
    if not spec:
        return None
    try:
        values = [float(part) for part in spec.split(":")]
    except ValueError:
        values = []
    if (len(values) != count or not all(0 < v <= 500 for v in values)
            or not all(v.is_integer() for v in values[:periods])):
        raise HTTPException(422, f"Indicator settings should look like {example}.")
    return values


def _series(values):
    """JSON-safe list: NaN becomes null."""
    return [None if np.isnan(v) else round(float(v), 4) for v in values]


def _weekly(bars):
    weeks = pd.to_datetime(bars.index, unit="s", utc=True).tz_convert(market.NY).tz_localize(None).to_period("W-FRI")
    return bars.assign(ts=bars.index).groupby(weeks).agg(
        ts=("ts", "first"), open=("open", "first"), high=("high", "max"), low=("low", "min"),
        close=("close", "last"), volume=("volume", "sum"),
    ).set_index("ts")


def _dollars(cents):
    if cents is None:
        return ""
    return f"{'-' if cents < 0 else ''}{abs(cents) // 100}.{abs(cents) % 100:02d}"


def create_app(run_worker=True):
    hosts = ["127.0.0.1", "localhost", *filter(None, os.environ.get("PAPERTRADER_HOSTS", "").split(","))]
    hub = Hub()
    worker = Worker(hub.publish)

    @asynccontextmanager
    async def lifespan(app):
        db.init()
        hub.loop = asyncio.get_running_loop()
        if run_worker:
            await worker.start()
        yield
        if run_worker:
            await worker.stop()

    app = FastAPI(
        title="Paper Trader",
        version=__version__,
        lifespan=lifespan,
        description="Paper trading with fake money on real prices, and a direction model that shows its own record. "
        "Money is in whole cents. Educational, not financial advice.",
    )
    app.state.worker, app.state.hub = worker, hub
    # another website can point its own domain at 127.0.0.1; only answer requests addressed to this computer
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)

    @app.middleware("http")
    async def own_pages_only(request, call_next):
        # any site can fire a plain POST at this computer; browsers always say where it came from
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin and urlsplit(origin).hostname not in hosts:
            return JSONResponse({"detail": "Only Paper Trader's own pages can change things.", "code": "origin"}, 403)
        return await call_next(request)

    async def refused(request, error):
        return JSONResponse({"detail": str(error), "code": error.code}, status_code=error.status)

    for kind in (ledger.LedgerError, market.MarketError, model.ModelError):
        app.add_exception_handler(kind, refused)

    def known(raw):
        """A clean symbol whose history is stored, downloading it (and checking it can be traded) the first time."""
        symbol = market.clean(raw)
        if not db.query("SELECT 1 FROM symbols WHERE symbol = ?", (symbol,)):
            market.refresh(symbol, "1d")
        return symbol

    # portfolios

    @app.get("/accounts", tags=["portfolio"])
    def list_accounts(include_archived: bool = False):
        return ledger.accounts(include_archived)

    @app.post("/accounts", status_code=201, tags=["portfolio"])
    def open_account(body: AccountIn):
        acct = ledger.create_account(body.name, body.starting_cash_cents)
        if settings.get()["account_id"] is None:
            settings.update({"account_id": acct["id"]})
        return acct

    @app.patch("/accounts/{account_id}", tags=["portfolio"])
    def rename_account(account_id: int, body: RenameIn):
        return ledger.rename_account(account_id, body.name)

    @app.post("/accounts/{account_id}/reset", tags=["portfolio"])
    def reset_account(account_id: int, body: ResetIn):
        """Archive the portfolio (its history stays readable) and start a fresh one under the same name."""
        fresh = ledger.reset_account(account_id, body.starting_cash_cents)
        if settings.get()["account_id"] == account_id:
            settings.update({"account_id": fresh["id"]})
        worker.orders_changed()
        return fresh

    @app.get("/portfolio/{account_id}", tags=["portfolio"])
    def portfolio(account_id: int):
        """Cash, positions with unrealized profit and loss in cents, total value and buying power."""
        return ledger.portfolio(account_id, worker.price, worker.prev_close, worker.day_start())

    @app.get("/portfolio/{account_id}/history", tags=["portfolio"])
    def history(
        account_id: int, page: Annotated[int, Query(ge=1)] = 1, page_size: Annotated[int, Query(ge=1, le=500)] = 50,
        symbol: str | None = None, side: Side | None = None,
    ):
        """The trade ledger, newest first, one page at a time."""
        ledger.account(account_id)
        return ledger.history(account_id, page, page_size, symbol and symbol.upper(), side)

    @app.get("/portfolio/{account_id}/history.csv", tags=["portfolio"])
    def history_csv(account_id: int):
        acct = ledger.account(account_id)
        out = io.StringIO()
        sheet = csv.writer(out)
        sheet.writerow(["executed_at", "symbol", "side", "type", "shares", "price", "commission", "total",
                        "realized_pnl", "cash_after"])
        for t in reversed(ledger.history(account_id, 1, 10**9)["items"]):
            when = datetime.fromtimestamp(t["executed_at"]).astimezone().isoformat(timespec="seconds")
            sheet.writerow([when, t["symbol"], t["side"], t["type"], t["shares"], _dollars(t["price_cents"]),
                            _dollars(t["commission_cents"]), _dollars(t["total_cents"]),
                            _dollars(t["realized_pnl_cents"]), _dollars(t["cash_after_cents"])])
        name = re.sub(r"[^a-z0-9]+", "-", acct["name"].lower()).strip("-") or "portfolio"
        return Response(out.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="paper-trader-{name}.csv"'})

    @app.get("/portfolio/{account_id}/equity", tags=["portfolio"])
    def equity(account_id: int, span: Annotated[str, Query(alias="range")] = "all"):
        """Daily value of the portfolio and of SPY, both indexed to 100 at the start of the range."""
        acct = ledger.account(account_id)
        start = max(market.day_start(acct["created_at"]), _since(span))
        spy = market.frame("SPY", "1d", since=start)
        days = [(int(ts), market.session_close(int(ts))) for ts in spy.index]
        traded = [r["symbol"] for r in db.query("SELECT DISTINCT symbol FROM trades WHERE account_id = ?", (account_id,))]
        closes = {s: (market.frame(s, "1d", since=0)["close"] * 100).round().astype(int) for s in traded}

        def close_on(symbol, day):
            upto = closes[symbol][closes[symbol].index <= day]
            return int(upto.iloc[-1]) if len(upto) else None

        t, values = [d for d, _ in days], ledger.equity_curve(account_id, days, close_on)
        bench = [round(c * 100) for c in spy["close"]]
        today = worker.day_start()
        live = ledger.portfolio(account_id, worker.price, worker.prev_close, today)["total_value_cents"]
        if not t or today > t[-1]:  # the session in progress, at live prices
            t, values, bench = [*t, today], [*values, live], [*bench, worker.price("SPY")]
        base_b = next((b for b in bench if b), None)
        return {
            "t": t, "equity_cents": values,
            "equity_index": [round(v / values[0] * 100, 3) for v in values],
            "benchmark": "SPY",
            "benchmark_index": [round(b / base_b * 100, 3) if b and base_b else None for b in bench],
        }

    # orders

    @app.post("/orders/execute", tags=["orders"],
              responses={202: {"description": "The market is closed: the order waits for the next open."}})
    def execute(body: MarketOrderIn):
        """Market order. Fills now at the live price; while the market is closed it waits for the next open,
        unless Practice mode is on, which fills at the last price."""
        symbol = known(body.symbol)
        worker.check_splits(symbol)  # on a split day, before the shares held are checked
        costs, prefs = settings.costs(), settings.get()
        price, practice = worker.fresh_price(symbol), False
        if price is None and prefs["practice_mode"]:
            price, practice = worker.price(symbol), True
        if price is None:
            last = worker.price(symbol)
            if last is None:
                raise market.MarketError(f"There is no price for {symbol} yet. Try again in a moment.")
            order = ledger.place_order(body.account_id, symbol, body.side, "MARKET", body.shares,
                                       ref_price_cents=last, costs=costs)
            worker.orders_changed()
            worker.watch(symbol)
            hub.publish({"type": "order", **order})
            return JSONResponse({**order, "queued": True}, status_code=202)
        receipt = ledger.execute_market(body.account_id, symbol, body.side, body.shares, price, costs)
        worker.watch(symbol)
        hub.publish({"type": "fill", **receipt})
        return {**receipt, "practice": practice}

    @app.post("/orders", status_code=201, tags=["orders"])
    def place_order(body: OrderIn):
        """A limit or stop order. It waits until the price reaches it, even while the app is closed."""
        symbol = known(body.symbol)
        worker.check_splits(symbol)
        order = ledger.place_order(body.account_id, symbol, body.side, body.type, body.shares, body.limit_cents,
                                   body.stop_cents, ref_price_cents=worker.price(symbol), costs=settings.costs())
        worker.orders_changed()
        worker.watch(symbol)
        hub.publish({"type": "order", **order})
        return order

    @app.get("/orders", tags=["orders"])
    def list_orders(account_id: int, status: Literal["OPEN", "FILLED", "CANCELLED", "REJECTED"] = "OPEN"):
        return ledger.orders(account_id, status)

    @app.delete("/orders/{order_id}", tags=["orders"])
    def cancel_order(order_id: int):
        order = ledger.cancel_order(order_id)
        worker.orders_changed()
        hub.publish({"type": "order", **order})
        return order

    # market data and the model

    @app.get("/market/search", tags=["market"])
    def search(q: Annotated[str, Query(min_length=1, max_length=40)]):
        return market.search(q)

    @app.get("/market/{symbol}/signal", tags=["market"])
    def signal(symbol: str, interval: Literal["1d", "1h"] = "1d"):
        """Latest price, the indicators behind the signal, the model's BUY, HOLD or SELL call for the next bar,
        its confidence, and how this model has done out of sample and live."""
        symbol = known(symbol)
        if market.needs_refresh(symbol, interval):
            market.refresh(symbol, interval)
        return {**model.report(symbol, interval), "price_cents": worker.price(symbol), "quote": worker.quotes.get(symbol)}

    recent = {}  # (symbol, interval, period) -> (fetched at, bars): minute bars from Yahoo, reused for a minute

    def minute_frame(symbol, interval, period):
        key = (symbol, interval, period)
        if key not in recent or time.time() - recent[key][0] > 60:
            recent[key] = (time.time(), market.intraday([symbol], period, interval).get(symbol, []))
        merged = {r["ts"]: r for r in recent[key][1]}
        for bar in worker.session_bars(symbol, interval):  # the stream is fresher than Yahoo for today
            if old := merged.get(bar["ts"]):  # Yahoo saw the bar open; the stream saw its latest price
                bar = {**bar, "open": old["open"], "high": max(old["high"], bar["high"]),
                       "low": min(old["low"], bar["low"]), "volume": max(old["volume"], bar["volume"])}
            merged[bar["ts"]] = bar
        rows = [merged[ts] for ts in sorted(merged)]
        return pd.DataFrame(
            {k: [r[k] / 100 for r in rows] for k in ("open", "high", "low", "close")}
            | {"volume": [float(r["volume"]) for r in rows]},
            index=[r["ts"] for r in rows],
        )

    @app.get("/market/{symbol}/chart", tags=["market"])
    def chart(
        symbol: str, interval: Literal["1m", "5m", "1h", "1d", "1w"] = "1d",
        span: Annotated[str, Query(alias="range")] = "1y",
        ma1: str = "ema:20", ma2: str = "sma:50", bb: str = "20:2", rsi: str = "14", macd: str = "12:26:9",
        account_id: int | None = None,
    ):
        """Bars (cents), the requested indicators, the model's out-of-sample and live calls, and your own fills."""
        symbol = known(symbol)
        worker.watch(symbol)
        if interval in MINUTE_RANGES:
            periods = MINUTE_RANGES[interval]
            if span not in periods:
                names = " or ".join(name.upper() for name in periods)
                raise HTTPException(422, f"{'1-minute' if interval == '1m' else '5-minute'} bars can show {names}.")
            bars = minute_frame(symbol, interval, periods[span])
            forming, since = worker.market_live() and not bars.empty, 0
        else:
            base = "1d" if interval == "1w" else interval
            if market.needs_refresh(symbol, base):
                market.refresh(symbol, base)
            bars = market.frame(symbol, base)
            live = worker.live_bar(symbol, base)
            forming = bool(live) and (bars.empty or int(live["ts"]) > int(bars.index[-1]))
            if forming:
                row = {k: live[k] / 100 for k in ("open", "high", "low", "close")} | {"volume": float(live["volume"])}
                bars = pd.concat([bars, pd.DataFrame([row], index=[live["ts"]])])
            if interval == "1w":
                bars = _weekly(bars)
            since = _since(span)
        close = bars["close"]
        prices, points = {}, {}  # lines in dollars (sent as cents), and RSI in points
        for key, spec in (("ma1", ma1), ("ma2", ma2)):
            if spec:
                kind, _, n = spec.partition(":")
                if kind not in ("ema", "sma") or not n.isdigit() or not 1 < int(n) <= 500:
                    raise HTTPException(422, "Moving averages should look like ema:20 or sma:50.")
                prices[key] = features.ema(close, int(n)) if kind == "ema" else close.rolling(int(n)).mean()
        if (b := _numbers(bb, 2, "20:2", periods=1)) is not None:
            mid, band = features.bollinger(close, int(b[0]), b[1])
            prices |= {"bb_mid": mid, "bb_upper": mid + band, "bb_lower": mid - band}
        if (r := _numbers(rsi, 1, "14", periods=1)) is not None:
            points["rsi"] = features.rsi(close, int(r[0]))
        if (m := _numbers(macd, 3, "12:26:9", periods=3)) is not None:
            prices["macd"], prices["macd_signal"], prices["macd_hist"] = features.macd(close, *map(int, m))
        keep = bars.index >= since
        shown = bars[keep]
        stamps = shown.index.to_numpy()

        def bar_of(ts):  # the bar a moment falls in, for placing markers
            i = np.searchsorted(stamps, ts, side="right") - 1
            return int(stamps[i]) if i >= 0 else None

        cutoff = int(stamps[0]) if len(stamps) else 0
        calls = []
        if interval in ("1d", "1h") and (chosen := model.active(symbol, interval)):
            calls = db.query(
                "SELECT ts, signal, confidence, 'backtest' AS kind FROM predictions WHERE model_id = ? AND ts >= ?"
                " AND signal != 'HOLD' UNION ALL SELECT ts, signal, confidence, 'live' FROM signals"
                " WHERE symbol = ? AND interval = ? AND ts >= ? AND signal != 'HOLD' ORDER BY ts",
                (chosen["id"], cutoff, symbol, interval, cutoff),
            )
        fills, position, orders = [], None, []
        if account_id is not None:
            for t in db.query("SELECT executed_at, side, shares, price_cents FROM trades WHERE account_id = ?"
                              " AND symbol = ? AND executed_at >= ? ORDER BY executed_at", (account_id, symbol, cutoff)):
                fills.append({**t, "t": bar_of(t["executed_at"])})
            held = [p for p in ledger.positions(account_id) if p["symbol"] == symbol]
            if held:
                position = {"shares": held[0]["shares"],
                            "avg_cost_cents": (2 * held[0]["cost_basis_cents"] + held[0]["shares"]) // (2 * held[0]["shares"])}
            orders = [{"id": o["id"], "side": o["side"], "type": o["type"], "shares": o["shares"],
                       "price_cents": o["limit_cents"] or o["stop_cents"]}
                      for o in ledger.orders(account_id) if o["symbol"] == symbol and o["type"] != "MARKET"]
        def whole(col):
            return [round(v * 100) for v in shown[col]]

        return {
            "symbol": symbol, "interval": interval, "forming": forming,
            "name": (db.query("SELECT name FROM symbols WHERE symbol = ?", (symbol,)) or [{"name": symbol}])[0]["name"],
            "bars": {"t": [int(t) for t in stamps], "o": whole("open"), "h": whole("high"), "l": whole("low"),
                     "c": whole("close"), "v": [int(v) for v in shown["volume"]]},
            "lines": {k: _series(v[keep] * 100) for k, v in prices.items()} | {k: _series(v[keep]) for k, v in points.items()},
            "calls": calls, "fills": fills, "position": position, "orders": orders,
        }

    @app.get("/watchlist", tags=["market"])
    def watchlist():
        items = db.query("SELECT w.symbol, s.name, s.kind FROM watchlist w JOIN symbols s USING (symbol) ORDER BY w.position")
        latest = {r["symbol"]: r for r in db.query(
            "SELECT symbol, signal, confidence, ts FROM signals s WHERE interval = '1d'"
            " AND ts = (SELECT MAX(ts) FROM signals WHERE symbol = s.symbol AND interval = '1d')")}
        return [{**item, "price_cents": worker.price(item["symbol"]), "prev_close_cents": worker.prev_close(item["symbol"]),
                 "quote": worker.quotes.get(item["symbol"]), "signal": latest.get(item["symbol"])} for item in items]

    @app.post("/watchlist", status_code=201, tags=["market"])
    def watch(body: WatchIn):
        """Add a symbol. Its history is downloaded the first time and its model trains in the background."""
        symbol = known(body.symbol)
        with db.tx() as conn:
            conn.execute("INSERT OR IGNORE INTO watchlist VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM watchlist))",
                         (symbol,))
        worker.watch(symbol)
        worker.submit(worker.update_history, symbol)
        return next(item for item in watchlist() if item["symbol"] == symbol)

    @app.delete("/watchlist/{symbol}", status_code=204, tags=["market"])
    def unwatch(symbol: str):
        with db.tx() as conn:
            conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol.upper(),))

    @app.put("/watchlist", tags=["market"])
    def reorder(body: ReorderIn):
        with db.tx() as conn:
            conn.executemany("UPDATE watchlist SET position = ? WHERE symbol = ?",
                             [(i, s.upper()) for i, s in enumerate(body.symbols)])
        return watchlist()

    @app.post("/models/{symbol}/runs", tags=["model"])
    def new_run(symbol: str, body: RunIn):
        """Walk-forward validation with these settings. Progress arrives over /ws as job events."""
        symbol = known(symbol)
        if market.needs_refresh(symbol, body.interval):
            market.refresh(symbol, body.interval)

        def progress(done):
            hub.publish({"type": "job", "symbol": symbol, "progress": round(done, 2)})

        return model.validate(symbol, model.Params.load(body.model_dump()), progress)

    @app.get("/models/{symbol}/runs", tags=["model"])
    def list_runs(symbol: str, interval: Literal["1d", "1h"] = "1d"):
        return model.runs(market.clean(symbol), interval)

    @app.get("/models/runs/{run_id}", tags=["model"])
    def get_run(run_id: int):
        return model.run(run_id)

    @app.post("/models/runs/{run_id}/activate", tags=["model"])
    def use_run(run_id: int):
        """Use this run for the live signal."""
        chosen = model.activate(run_id)
        hub.publish({"type": "signal", **model.live_signal(chosen["symbol"], chosen["interval"])})
        return chosen

    # the app

    @app.get("/settings", tags=["app"])
    def get_settings():
        return settings.get()

    @app.put("/settings", tags=["app"])
    def put_settings(body: SettingsIn):
        changes = body.model_dump(exclude_unset=True, exclude_none=True)  # a null would wipe out the default
        if changes.get("account_id") is not None:
            ledger.account(changes["account_id"])
        return settings.update(changes)

    @app.get("/status", tags=["app"])
    def status():
        return worker.status()

    @app.get("/health", tags=["app"])
    def health():
        return {"ok": True, "version": __version__}

    @app.websocket("/ws")
    async def live(ws: WebSocket):
        # browsers let any page open a WebSocket to this computer, so only our own pages may listen
        origin = ws.headers.get("origin")
        if origin and urlsplit(origin).hostname not in hosts:
            await ws.close(code=1008)
            return
        await ws.accept()
        queue = asyncio.Queue(maxsize=1_000)
        hub.queues.add(queue)

        async def listen():
            try:
                async for message in ws.iter_json():
                    if isinstance(message, dict) and message.get("type") == "watch" and isinstance(message.get("symbol"), str):
                        try:
                            worker.watch(market.clean(message["symbol"]))
                        except market.MarketError:
                            pass
            except (WebSocketDisconnect, ValueError):  # ValueError: a frame that isn't JSON
                pass

        reader = asyncio.create_task(listen())
        try:
            await ws.send_json({"type": "hello", "quotes": list(worker.quotes.values()), **worker.status()})
            while True:
                await ws.send_json(await queue.get())
        except (WebSocketDisconnect, RuntimeError):  # RuntimeError: sending after the window closed
            pass
        finally:
            hub.queues.discard(queue)
            reader.cancel()

    static = db.ROOT / "static"
    if (static / "index.html").exists():
        app.mount("/", StaticFiles(directory=static, html=True), name="ui")
    return app
