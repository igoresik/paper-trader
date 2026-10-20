from papertrader.worker import Worker

OPEN = 1_792_416_600  # Monday 2026-10-19, 09:30 New York


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
