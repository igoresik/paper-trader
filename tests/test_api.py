import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from papertrader import api, db, ledger, market


def walk(n=400, seed=0):
    rng = np.random.default_rng(seed)
    return list(150 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))), list(rng.integers(1_000_000, 2_000_000, n))


@pytest.fixture
def app(monkeypatch, put_bars):
    def offline(*args, **kwargs):
        raise AssertionError("tests never call Yahoo")

    monkeypatch.setattr(market, "needs_refresh", lambda *args, **kwargs: False)
    monkeypatch.setattr(market, "refresh", offline)
    monkeypatch.setattr(market, "intraday", offline)
    monkeypatch.setattr(market, "check_splits", lambda symbol: None)
    put_bars("AAPL", *walk())
    application = api.create_app(run_worker=False)
    application.state.worker.fresh_price = lambda symbol: 15_000  # a live $150.00
    application.state.worker.submit = lambda *args: None
    return application


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def open_account(client, cash=100_000):
    return client.post("/accounts", json={"name": "Main", "starting_cash_cents": cash}).json()["id"]


def market_order(client, acc, shares, side="BUY"):
    return client.post("/orders/execute", json={"account_id": acc, "symbol": "aapl", "side": side, "shares": shares})


def test_a_buy_shows_up_in_the_portfolio_and_the_history(client):
    acc = open_account(client, 1_000_000)
    receipt = market_order(client, acc, 10)
    assert receipt.status_code == 200
    assert (receipt.json()["total_cents"], receipt.json()["cash_after_cents"]) == (150_000, 850_000)
    portfolio = client.get(f"/portfolio/{acc}").json()
    assert (portfolio["cash_cents"], portfolio["positions"][0]["shares"]) == (850_000, 10)
    history = client.get(f"/portfolio/{acc}/history").json()
    assert (history["total"], history["items"][0]["type"]) == (1, "MARKET")


def test_a_refused_order_explains_itself(client):
    acc = open_account(client, 100_000)
    refused = market_order(client, acc, 7)
    assert refused.status_code == 400
    assert refused.json() == {"detail": "Not enough cash: this order needs $1,050.00 and you have $1,000.00.",
                              "code": "insufficient_funds"}


def test_market_orders_wait_for_the_open_unless_practising(app, client):
    app.state.worker.fresh_price = lambda symbol: None  # market closed
    acc = open_account(client)
    queued = market_order(client, acc, 2)
    assert queued.status_code == 202
    assert (queued.json()["status"], queued.json()["queued"]) == ("OPEN", True)
    client.put("/settings", json={"practice_mode": True})
    filled = market_order(client, acc, 1)
    assert filled.status_code == 200
    assert filled.json()["practice"] is True


def test_requests_addressed_to_other_hosts_are_refused(app):
    with TestClient(app, base_url="http://evil.example") as c:
        assert c.get("/health").status_code == 400


def test_other_sites_cannot_listen_to_live_updates(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("ws://127.0.0.1/ws", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()
    assert refused.value.code == 1008  # turned away by the origin check, not the host check
    with client.websocket_connect("ws://127.0.0.1/ws", headers={"origin": "http://127.0.0.1:5173"}) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_other_sites_cannot_change_anything(client):
    # a page elsewhere can still fire a plain POST at this computer, even if it can't read the answer
    refused = client.post("/models/runs/1/activate", headers={"origin": "http://evil.example"})
    assert refused.status_code == 403
    assert client.post("/models/runs/1/activate", headers={"origin": "http://127.0.0.1:5173"}).json()["code"] == "model"


def test_the_signal_comes_with_its_reasons_and_record(client):
    signal = client.get("/market/AAPL/signal").json()
    assert signal["signal"] in ("BUY", "HOLD", "SELL")
    assert 0 <= signal["confidence"] <= 1
    assert set(signal["indicators"]) == {"rsi", "ema_spread", "vol_z", "pct_b", "bb_width"}
    assert signal["model"]["summary"]["verdict"]
    assert signal["live_record"] == {"n": 0, "right": 0}


def test_limit_orders_wait_and_can_be_cancelled_once(client):
    acc = open_account(client)
    body = {"account_id": acc, "symbol": "AAPL", "side": "BUY", "type": "LIMIT", "shares": 1, "limit_cents": 10_000}
    order = client.post("/orders", json=body).json()
    assert client.get("/orders", params={"account_id": acc}).json()[0]["id"] == order["id"]
    assert client.delete(f"/orders/{order['id']}").json()["status"] == "CANCELLED"
    assert client.delete(f"/orders/{order['id']}").status_code == 409


def test_an_order_on_a_split_day_sees_the_new_share_count(app, client, monkeypatch):
    acc = open_account(client, cash=1_000_000)
    ledger.execute_market(acc, "AAPL", "BUY", 10, 30_000, now=int(time.time()) - 3 * 86_400)

    def yahoo_marks_a_split(symbol):
        with db.tx() as conn:
            conn.execute("INSERT OR IGNORE INTO splits (symbol, ts, ratio) VALUES (?, ?, 2.0)",
                         (symbol, market.day_start(time.time())))

    monkeypatch.setattr(market, "check_splits", yahoo_marks_a_split)
    monkeypatch.setattr(market, "session", lambda now=None: "regular")
    assert market_order(client, acc, 15, side="SELL").status_code == 200  # 10 old shares are 20 new ones
    assert ledger.positions(acc)[0]["shares"] == 5


def test_settings_are_checked(client):
    assert client.put("/settings", json={"slippage_bps": -1}).status_code == 422
    assert client.put("/settings", json={"nonsense": 1}).status_code == 422
    assert client.put("/settings", json={"theme": "dark"}).json()["theme"] == "dark"
    assert client.put("/settings", json={"commission_cents": None}).json()["commission_cents"] == 0


def test_chart_lines_up_with_its_bars(client):
    acc = open_account(client)
    market_order(client, acc, 1)
    chart = client.get("/market/AAPL/chart", params={"range": "all", "account_id": acc}).json()
    n = len(chart["bars"]["t"])
    assert n == 400 and all(len(line) == n for line in chart["lines"].values())
    assert chart["lines"]["rsi"][0] is None  # still warming up
    assert chart["fills"][0]["t"] in chart["bars"]["t"]
    assert chart["position"]["shares"] == 1
    weekly = client.get("/market/AAPL/chart", params={"interval": "1w", "range": "all"}).json()
    assert 55 <= len(weekly["bars"]["t"]) <= 60
    assert client.get("/market/AAPL/chart", params={"ma1": "wma:5"}).status_code == 422
    assert client.get("/market/AAPL/chart", params={"rsi": "0.5"}).status_code == 422
    assert client.get("/market/AAPL/chart", params={"bb": "20:0.5"}).status_code == 200


def test_chart_adds_the_bar_still_forming(app, client):
    last = client.get("/market/AAPL/chart", params={"range": "all"}).json()["bars"]["t"][-1]
    session = last + 86_400 + 13 * 3_600 + 30 * 60  # next day, 09:30 New York (UTC-4)
    app.state.worker.minutes["AAPL"] = {session: [15_000, 15_100, 14_900, 15_050, 1_000],
                                       session + 60: [15_050, 15_200, 15_000, 15_150, 2_000]}
    chart = client.get("/market/AAPL/chart", params={"range": "all"}).json()
    assert chart["forming"] is True
    assert (chart["bars"]["h"][-1], chart["bars"]["c"][-1], chart["bars"]["v"][-1]) == (15_200, 15_150, 3_000)


def test_minute_chart_adds_the_streamed_minutes_to_yahoos(app, client, monkeypatch):
    opened = 1_792_416_600  # Monday 2026-10-19, 09:30 New York
    yahoo = [{"ts": opened + 60 * i, "open": 15_000, "high": 15_010, "low": 14_990, "close": 15_000 + i, "volume": 500}
             for i in range(3)]
    five_minute = [{"ts": opened, "open": 15_000, "high": 15_010, "low": 14_990, "close": 15_002, "volume": 1_500}]
    monkeypatch.setattr(market, "intraday", lambda symbols, period, interval: {"AAPL": yahoo if interval == "1m" else five_minute})
    worker = app.state.worker
    worker.minutes["AAPL"] = {opened + 120: [15_002, 15_050, 15_000, 15_040, 100], opened + 180: [15_040, 15_060, 15_030, 15_055, 80]}
    worker.market_live = lambda: True
    chart = client.get("/market/AAPL/chart", params={"interval": "1m", "range": "1d"}).json()
    assert chart["bars"]["t"] == [opened, opened + 60, opened + 120, opened + 180]
    assert chart["bars"]["c"][2:] == [15_040, 15_055]  # the stream wins for the minutes it has seen
    assert chart["bars"]["v"][2] == 500  # but never with less volume than Yahoo counted
    assert (chart["forming"], chart["calls"]) == (True, [])
    five = client.get("/market/AAPL/chart", params={"interval": "5m", "range": "5d"}).json()
    assert five["bars"]["t"] == [opened]  # every minute so far falls in the 09:30 bar
    # Yahoo saw the 09:30 open; the stream has the newest price and a higher high
    assert (five["bars"]["o"], five["bars"]["h"], five["bars"]["c"], five["bars"]["v"]) == ([15_000], [15_060], [15_055], [1_500])
    assert client.get("/market/AAPL/chart", params={"interval": "1m", "range": "1y"}).status_code == 422


def test_history_downloads_as_csv(client):
    acc = open_account(client)
    market_order(client, acc, 2)
    sheet = client.get(f"/portfolio/{acc}/history.csv")
    assert sheet.headers["content-disposition"] == 'attachment; filename="paper-trader-main.csv"'
    row = sheet.text.splitlines()[1].split(",")
    assert row[1:6] == ["AAPL", "BUY", "MARKET", "2", "150.00"]


def test_watchlist_keeps_its_order(client, put_bars):
    put_bars("MSFT", *walk(seed=1))
    for symbol in ("aapl", "msft"):
        assert client.post("/watchlist", json={"symbol": symbol}).status_code == 201
    assert [i["symbol"] for i in client.put("/watchlist", json={"symbols": ["MSFT", "AAPL"]}).json()] == ["MSFT", "AAPL"]


def test_equity_curve_starts_at_100(client):
    acc = open_account(client)
    assert client.get(f"/portfolio/{acc}/equity").json()["equity_index"][0] == 100
