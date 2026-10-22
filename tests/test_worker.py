import threading
import time

import pytest

from papertrader import db, ledger, market
from papertrader.worker import Worker

OPEN = 1_792_416_600  # Monday 2026-10-19, 09:30 New York


@pytest.fixture(autouse=True)
def no_yahoo(monkeypatch):
    # during real market hours the matcher checks splits first, and a slow Yahoo held fills past wait_for
    monkeypatch.setattr(market, "check_splits", lambda symbol: None)


def worker_with_minutes(count):
    worker = Worker(lambda event: None)
    worker.minutes["SPY"] = {OPEN + 60 * i: [100 + i, 110 + i, 90 + i, 105 + i, 10] for i in range(count)}
    return worker


def test_session_minutes_group_into_bars_from_the_open():
    bars = worker_with_minutes(12).session_bars("SPY", "5m")
    assert [b["ts"] for b in bars] == [OPEN, OPEN + 300, OPEN + 600]
    first = bars[0]
    assert (first["open"], first["high"], first["low"], first["close"], first["volume"]) == (100, 114, 90, 109, 50)
    assert bars[-1]["volume"] == 20  # 09:40 and 09:41 so far


def test_the_forming_bar_for_each_interval():
    worker = worker_with_minutes(75)  # 09:30 to 10:44
    assert worker.live_bar("SPY", "1h")["ts"] == OPEN + 3_600  # hourly bars start at 10:30
    day = worker.live_bar("SPY", "1d")
    assert (day["open"], day["close"], day["volume"]) == (100, 179, 750)
    assert worker.live_bar("SPY", "1m")["ts"] == OPEN + 74 * 60


def test_ticks_add_the_volume_traded_since_the_last_one():
    worker = Worker(lambda event: None)
    for second, total in ((5, 1_000), (20, 1_250), (70, 1_300)):
        worker._tick({"id": "SPY", "price": 770.0, "time": str((OPEN + second) * 1000), "market_hours": 1, "day_volume": str(total)})
    minutes = worker.minutes["SPY"]
    assert (minutes[OPEN][4], minutes[OPEN + 60][4]) == (250, 50)  # the first tick only sets the starting total


def tick(worker, price, second=0):
    worker._tick({"id": "AAPL", "price": price, "time": str((OPEN + second) * 1000), "market_hours": 1})


def test_fills_dont_wait_behind_slow_background_work():
    acc = ledger.create_account("Main", 100_000)["id"]
    ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 1, limit_cents=10_000, now=OPEN - 60)
    worker = Worker(lambda event: None)
    worker.orders_changed()
    busy = threading.Event()
    for _ in range(2):
        worker.pool.submit(busy.wait, 10)  # history refresh or model training holding both threads
    try:
        tick(worker, 99.0)
        assert wait_for(lambda: ledger.orders(acc, "FILLED"))
    finally:
        busy.set()


def test_ticks_that_arrive_mid_match_are_matched_together_next():
    worker, runs, release = Worker(lambda event: None), [], threading.Event()
    worker.with_orders = {"AAPL"}

    def match(symbol, ticks):
        runs.append(len(ticks))
        release.wait(10)

    worker.match = match
    tick(worker, 150.0)
    assert wait_for(lambda: runs == [1])
    for second in (1, 2, 3):
        tick(worker, 150.0, second)
    release.set()
    assert wait_for(lambda: runs == [1, 3])


def test_a_split_reaches_open_orders_before_ticks_at_the_new_price(monkeypatch):
    acc = ledger.create_account("Main", 100_000)["id"]
    ledger.execute_market(acc, "AAPL", "BUY", 10, 9_500, now=OPEN - 86_400)
    ledger.place_order(acc, "AAPL", "SELL", "STOP", 10, stop_cents=9_000, now=OPEN - 86_400)

    def yahoo_marks_a_split(symbol):
        with db.tx() as conn:
            conn.execute("INSERT OR IGNORE INTO splits (symbol, ts, ratio) VALUES (?, ?, 10.0)", (symbol, market.day_start(OPEN)))

    monkeypatch.setattr(market, "check_splits", yahoo_marks_a_split)
    monkeypatch.setattr(market, "session", lambda now=None: "regular")
    worker = Worker(lambda event: None)
    worker.orders_changed()
    tick(worker, 9.60)  # $96 before the split: above the $90 stop
    worker.matcher.submit(lambda: None).result()
    stop = ledger.orders(acc)  # still open, now on the new share count
    assert [(o["shares"], o["stop_cents"]) for o in stop] == [(100, 900)]
    assert ledger.positions(acc)[0]["shares"] == 100


def wait_for(check, seconds=5):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return True
        time.sleep(0.02)
    return False


def test_a_short_is_bought_back_live_once_its_buy_in_price_trades(monkeypatch):
    monkeypatch.setattr(market, "check_splits", lambda symbol: None)
    acc = ledger.create_account("Main", 100_000_00)["id"]
    ledger.execute_market(acc, "AAPL", "SELL", 10, 10_000, short=True, now=OPEN - 60)
    worker = Worker(lambda event: None)
    worker.orders_changed()
    assert worker.with_orders == {"AAPL"}  # no open orders, but a buy-in to watch
    tick(worker, 115.0)  # the buy-in is at $115.39
    tick(worker, 115.5, 1)
    assert wait_for(lambda: ledger.positions(acc) == [])
    assert ledger.history(acc)["items"][0]["price_cents"] == 11_550
