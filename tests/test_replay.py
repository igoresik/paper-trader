import pytest
from fastapi.testclient import TestClient

from papertrader import api, db, ledger, market, model, replay
from papertrader.ledger import LedgerError

START, DAY = 1_600_000_000, 86_400


@pytest.fixture
def aapl(put_bars):
    put_bars("AAPL", [100.0 + i for i in range(30)], start=START)  # $100.00, $101.00, ... one a day


def test_a_replay_sees_only_the_days_up_to_its_clock(aapl):
    s = replay.start("AAPL", START + 5 * DAY, 100_000)
    assert (s["clock"], s["days_played"], s["days_left"]) == (START + 5 * DAY, 0, 24)
    assert s["portfolio"]["total_value_cents"] == 100_000
    assert ledger.accounts() == []  # replays stay out of the live portfolio list
    assert [r["id"] for r in ledger.replays()] == [s["account"]["id"]]


def test_a_market_order_fills_at_the_next_open_and_values_at_the_clock(aapl):
    acc = replay.start("AAPL", START, 1_000_000)["account"]["id"]
    replay.order(acc, "BUY", "MARKET", 10)
    assert replay.step(acc)[0]["price_cents"] == 10_100  # day 2 opens at $101
    replay.order(acc, "SELL", "LIMIT", 10, limit_cents=10_500)
    replay.step(acc, 3)  # $102, $103, $104: not yet
    assert ledger.orders(acc)[0]["status"] == "OPEN"
    fills = replay.step(acc, 5)
    assert [f["price_cents"] for f in fills] == [10_500]
    s = replay.state(acc)
    assert s["days_played"] == 9 and s["portfolio"]["cash_cents"] == 1_000_000 + 4_000
    assert s["report"]["sells"] == 1 and s["report"]["wins"] == 1
    assert s["report"]["benchmark_return"] == pytest.approx(109 / 100 - 1)


def test_live_prices_never_fill_a_replay_order(aapl):
    acc = replay.start("AAPL", START, 1_000_000)["account"]["id"]
    replay.order(acc, "BUY", "LIMIT", 1, limit_cents=9_000)
    assert ledger.match("AAPL", [{"ts": START + 99 * DAY, "open": 8_000, "high": 8_000, "low": 8_000, "close": 8_000}]) == []
    with pytest.raises(LedgerError):
        ledger.live_only(acc)


def test_a_split_leaves_replays_alone(aapl):
    acc = replay.start("AAPL", START, 1_000_000)["account"]["id"]
    replay.order(acc, "BUY", "MARKET", 10)
    replay.step(acc)
    with db.tx() as conn:  # a split the live portfolios have to follow; replay prices are already adjusted
        conn.execute("INSERT INTO splits (symbol, ts, ratio) VALUES ('AAPL', ?, 2.0)", (START + 20 * DAY,))
    ledger.apply_splits("AAPL")
    assert ledger.positions(acc)[0]["shares"] == 10


def test_the_replay_scores_the_models_out_of_sample_calls_for_the_same_days(aapl):
    acc = replay.start("AAPL", START, 1_000_000)["account"]["id"]
    with db.tx() as conn:
        conn.execute("INSERT INTO models (id, symbol, interval, params, metrics, active) VALUES (1, 'AAPL', '1d', '{}', '{}', 1)")
        conn.executemany("INSERT INTO predictions VALUES (1, ?, ?, 0.5, 'BUY')",
                         [(START, "BUY"), (START + DAY, "SELL"), (START + 2 * DAY, "BUY")])
    replay.step(acc, 2)  # the third call's next close is still in the future
    followed = replay.state(acc)["report"]["model"]
    assert followed["days"] == 2 and followed["return"] == pytest.approx(101 / 100 - 1)


def test_replay_api(aapl, monkeypatch):
    monkeypatch.setattr(market, "needs_refresh", lambda *args, **kwargs: False)
    with TestClient(api.create_app(run_worker=False), base_url="http://127.0.0.1") as client:
        started = client.post("/replays", json={"symbol": "aapl", "start": START + 3 * DAY}).json()
        acc = started["account"]["id"]
        chart = client.get("/market/AAPL/chart", params={"until": started["clock"], "range": "all", "account_id": acc}).json()
        assert chart["bars"]["t"][-1] == started["clock"] and not chart["forming"]
        assert client.post(f"/replays/{acc}/orders", json={"side": "BUY", "type": "MARKET", "shares": 2}).status_code == 201
        stepped = client.post(f"/replays/{acc}/step", json={"days": 1}).json()
        assert stepped["fills"][0]["shares"] == 2 and stepped["state"]["days_played"] == 1
        live_order = {"account_id": acc, "symbol": "AAPL", "side": "BUY", "shares": 1}
        assert client.post("/orders/execute", json=live_order).status_code == 400
        assert client.delete(f"/replays/{acc}").status_code == 204
        assert client.get("/replays").json() == []
