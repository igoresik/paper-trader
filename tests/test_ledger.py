import sqlite3
import threading

import pytest

from papertrader import db, ledger
from papertrader.ledger import Conflict, Costs, InsufficientFunds, NotEnoughShares

T0 = 1_760_000_000  # fixed clock for orders and bars


def account(cash=100_000):
    return ledger.create_account("Main", cash)["id"]


def buy(acc, shares, price, **kw):
    return ledger.execute_market(acc, "AAPL", "BUY", shares, price, **kw)


def sell(acc, shares, price, **kw):
    return ledger.execute_market(acc, "AAPL", "SELL", shares, price, **kw)


def bar(ts, o, h=None, low=None):
    return {"ts": ts, "open": o, "high": h or o, "low": low or o, "close": o}


def snapshot():
    """Everything an order can touch, to prove a refused one changed nothing."""
    return [db.query(f"SELECT * FROM {table}") for table in ("accounts", "positions", "orders", "trades")]


def count(table):
    return db.query(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"]


def run_together(fn, n):
    """Start n calls at the same moment and return how many were accepted."""
    start = threading.Barrier(n)
    results = []

    def worker():
        start.wait()
        try:
            fn()
            results.append(True)
        except ledger.LedgerError:
            results.append(False)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == n  # nothing failed in an unexpected way
    return results.count(True)


# market orders


def test_buy_takes_cash_and_opens_a_position():
    acc = account(100_000)
    receipt = buy(acc, 10, 1_050)
    assert (receipt["total_cents"], receipt["cash_after_cents"]) == (10_500, 89_500)
    assert ledger.positions(acc) == [{"symbol": "AAPL", "shares": 10, "cost_basis_cents": 10_500}]
    assert count("trades") == 1


def test_buy_without_enough_cash_changes_nothing():
    acc = account(10_000)
    before = snapshot()
    with pytest.raises(InsufficientFunds, match=r"needs \$100\.01 and you have \$100\.00"):
        buy(acc, 1, 10_001)
    assert snapshot() == before


def test_cannot_sell_shares_you_do_not_own():
    acc = account()
    before = snapshot()
    with pytest.raises(NotEnoughShares, match="You don't own any AAPL"):
        sell(acc, 1, 1_000)
    assert snapshot() == before


def test_cannot_sell_more_than_you_own():
    acc = account()
    buy(acc, 5, 1_000)
    before = snapshot()
    with pytest.raises(NotEnoughShares, match="You own 5 AAPL, so you can sell up to 5"):
        sell(acc, 6, 1_000)
    assert snapshot() == before


def test_selling_everything_removes_the_position_and_books_the_profit():
    acc = account(100_000)
    buy(acc, 10, 1_000)
    receipt = sell(acc, 10, 1_200)
    assert (receipt["realized_pnl_cents"], receipt["cash_after_cents"]) == (2_000, 102_000)
    assert ledger.positions(acc) == []


def test_partial_sells_split_the_cost_basis_without_leftovers():
    acc = account(100_000)
    buy(acc, 3, 1_000, costs=Costs(commission_cents=1))  # basis 3,001 for 3 shares
    first = sell(acc, 1, 1_000)
    assert ledger.positions(acc)[0]["cost_basis_cents"] == 2_001
    last = sell(acc, 2, 1_000)
    assert first["realized_pnl_cents"] + last["realized_pnl_cents"] == -1  # only the commission was lost
    assert ledger.positions(acc) == []


def test_costs_always_round_against_the_trader():
    acc = account(1_000_000)
    costs = Costs(commission_bps=1, slippage_bps=3)
    bought = buy(acc, 7, 3_333, costs=costs)
    # 3,333 x 1.0003 = 3,333.9999 -> 3,334; commission 0.01% of 23,338 = 2.33 -> 3
    assert (bought["price_cents"], bought["commission_cents"], bought["total_cents"]) == (3_334, 3, 23_341)
    sold = sell(acc, 7, 3_333, costs=costs)
    # 3,333 x 0.9997 = 3,332.0001 -> 3,332; commission 0.01% of 23,324 = 2.33 -> 3
    assert (sold["price_cents"], sold["commission_cents"], sold["total_cents"]) == (3_332, 3, 23_321)


def test_the_trade_ledger_is_append_only():
    acc = account()
    buy(acc, 1, 1_000)
    for sql in ("UPDATE trades SET price_cents = 1", "DELETE FROM trades"):
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            with db.tx() as conn:
                conn.execute(sql)
    assert count("trades") == 1


def test_the_database_itself_refuses_negative_cash():
    acc = account(1_000)
    with pytest.raises(sqlite3.IntegrityError):
        with db.tx() as conn:
            conn.execute("UPDATE accounts SET cash_balance_cents = cash_balance_cents - 1001 WHERE id = ?", (acc,))
    assert ledger.account(acc)["cash_balance_cents"] == 1_000


def test_parallel_buys_never_spend_more_than_the_cash():
    acc = account(100_000)  # $1,000: room for exactly 10 shares at $100
    assert run_together(lambda: buy(acc, 1, 10_000), 20) == 10
    assert ledger.account(acc)["cash_balance_cents"] == 0
    assert ledger.positions(acc)[0]["shares"] == 10
    assert count("trades") == 10


def test_parallel_sells_never_sell_more_than_owned():
    acc = account(100_000)
    buy(acc, 5, 1_000)
    assert run_together(lambda: sell(acc, 1, 1_000), 10) == 5
    assert ledger.positions(acc) == []


# orders that wait for their price


@pytest.mark.parametrize(
    "side, kind, limit, stop, b, expected",
    [
        ("BUY", "LIMIT", 1_000, None, bar(T0, 1_010, 1_020, 1_005), None),  # never came down to the limit
        ("BUY", "LIMIT", 1_000, None, bar(T0, 1_010, 1_020, 995), 1_000),  # touched it
        ("BUY", "LIMIT", 1_000, None, bar(T0, 990, 995, 980), 990),  # opened below: the better price
        ("SELL", "LIMIT", 1_000, None, bar(T0, 990, 1_005, 980), 1_000),
        ("SELL", "LIMIT", 1_000, None, bar(T0, 1_010, 1_020, 1_005), 1_010),
        ("BUY", "STOP", None, 1_000, bar(T0, 990, 1_002, 985), 1_000),
        ("BUY", "STOP", None, 1_000, bar(T0, 1_010, 1_020, 1_005), 1_010),  # gapped over the stop: worse
        ("SELL", "STOP", None, 1_000, bar(T0, 1_010, 1_015, 998), 1_000),
        ("SELL", "STOP", None, 1_000, bar(T0, 990, 995, 980), 990),  # gapped under the stop
        ("SELL", "STOP", None, 1_000, bar(T0, 1_010, 1_020, 1_001), None),
        ("BUY", "MARKET", None, None, bar(T0, 1_234, 1_300, 1_200), 1_234),  # queued: the next open
    ],
)
def test_trigger_prices(side, kind, limit, stop, b, expected):
    order = {"side": side, "type": kind, "limit_cents": limit, "stop_cents": stop}
    assert ledger.trigger_price(order, b) == expected


def test_orders_ignore_prices_from_before_they_were_placed():
    acc = account(100_000)
    ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 10, limit_cents=1_000, now=T0)
    bars = [bar(T0 - 60, 990), bar(T0, 1_010, 1_020, 1_005), bar(T0 + 60, 1_004, 1_006, 999)]
    [fill] = ledger.match("AAPL", bars)
    assert (fill["price_cents"], fill["executed_at"]) == (1_000, T0 + 60)


def test_an_order_fills_only_once():
    acc = account(100_000)
    ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 10, limit_cents=1_000, now=T0)
    bars = [bar(T0 + 60, 999)]
    fills = []
    run_together(lambda: fills.extend(ledger.match("AAPL", bars)), 5)
    fills.extend(ledger.match("AAPL", bars))  # a catch-up run over the same bars
    assert len(fills) == 1
    assert count("trades") == 1


def test_queued_market_order_fills_at_the_next_open_with_slippage():
    acc = account(100_000)
    costs = Costs(slippage_bps=10)
    ledger.place_order(acc, "AAPL", "BUY", "MARKET", 2, ref_price_cents=1_000, costs=costs, now=T0)
    [fill] = ledger.match("AAPL", [bar(T0 + 3_600, 1_100, 1_150, 1_090)], costs)
    assert fill["price_cents"] == 1_102  # 1,100 + 0.1%, rounded up


def test_order_that_cannot_be_paid_at_fill_time_is_rejected():
    acc = account(10_000)
    ledger.place_order(acc, "AAPL", "BUY", "STOP", 9, stop_cents=1_100, ref_price_cents=1_000, now=T0)  # holds $99
    [event] = ledger.match("AAPL", [bar(T0 + 60, 1_200)])  # gapped to $12: needs $108
    assert event["status"] == "REJECTED"
    assert "Not enough cash" in event["reason"]
    assert ledger.positions(acc) == []
    assert ledger.account(acc)["cash_balance_cents"] == 10_000


def test_open_buy_orders_hold_cash_until_cancelled():
    acc = account(100_000)
    order = ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 90, limit_cents=1_000, now=T0)  # holds $900
    with pytest.raises(InsufficientFunds, match=r"\$900\.00 is held for open orders"):
        buy(acc, 2, 6_000)
    ledger.cancel_order(order["id"])
    buy(acc, 2, 6_000)


def test_open_sell_orders_hold_shares():
    acc = account(100_000)
    buy(acc, 5, 1_000)
    ledger.place_order(acc, "AAPL", "SELL", "LIMIT", 4, limit_cents=1_500, now=T0)
    with pytest.raises(NotEnoughShares, match="sell up to 1"):
        sell(acc, 2, 1_000)


def test_buy_stop_must_be_above_the_current_price():
    acc = account()
    with pytest.raises(ledger.LedgerError, match="above the current price"):
        ledger.place_order(acc, "AAPL", "BUY", "STOP", 1, stop_cents=900, ref_price_cents=1_000)


def test_only_open_orders_can_be_cancelled():
    acc = account()
    order = ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 1, limit_cents=1_000, now=T0)
    ledger.cancel_order(order["id"])
    with pytest.raises(Conflict, match="already cancelled"):
        ledger.cancel_order(order["id"])


# portfolios


def test_reset_keeps_the_old_portfolio_and_starts_a_fresh_one():
    acc = account(100_000)
    buy(acc, 10, 1_000)
    order = ledger.place_order(acc, "AAPL", "BUY", "LIMIT", 1, limit_cents=900, now=T0)
    fresh = ledger.reset_account(acc, 50_000)
    assert (fresh["name"], fresh["cash_balance_cents"]) == ("Main", 50_000)
    assert db.query("SELECT status FROM orders WHERE id = ?", (order["id"],))[0]["status"] == "CANCELLED"
    assert ledger.history(acc)["total"] == 1  # the old ledger stays readable
    with pytest.raises(Conflict, match="reset"):
        buy(acc, 1, 1_000)


def test_portfolio_names_are_unique():
    account()
    with pytest.raises(Conflict, match="already a portfolio called Main"):
        ledger.create_account(" Main ", 1_000)


def test_history_pages_newest_first_and_filters():
    acc = account(1_000_000)
    for i in range(5):
        buy(acc, 1, 1_000 + i, now=T0 + i)
    sell(acc, 2, 2_000, now=T0 + 10)
    page = ledger.history(acc, page=1, page_size=2)
    assert page["total"] == 6
    assert [t["side"] for t in page["items"]] == ["SELL", "BUY"]
    assert ledger.history(acc, page=3, page_size=2)["items"][-1]["price_cents"] == 1_000
    assert ledger.history(acc, side="SELL")["total"] == 1


def test_portfolio_values_positions_and_counts_today_from_each_fill():
    acc = account(100_000)
    buy(acc, 10, 1_000, now=T0)  # held overnight
    day_start = T0 + 86_400
    buy(acc, 5, 1_100, now=day_start + 100)  # bought today
    p = ledger.portfolio(acc, prices={"AAPL": 1_200}, prev_closes={"AAPL": 1_050}, day_start=day_start)
    [pos] = p["positions"]
    assert (pos["market_value_cents"], pos["unrealized_pnl_cents"]) == (18_000, 18_000 - 15_500)
    # 10 old shares 10.50 -> 12.00 (+15.00); 5 new shares 11.00 -> 12.00 (+5.00)
    assert pos["day_change_cents"] == 2_000
    assert p["total_value_cents"] == 100_000 - 15_500 + 18_000
    assert p["buying_power_cents"] == 84_500


@pytest.mark.parametrize("cents, text", [(0, "$0.00"), (5, "$0.05"), (123_456_789, "$1,234,567.89"), (-1_050, "-$10.50")])
def test_money(cents, text):
    assert ledger.money(cents) == text
