import numpy as np
import pandas as pd
import pytest

from papertrader import db, model
from papertrader.model import ModelError, Params

FAST = Params(trees=40, max_depth=2)


def random_walk(n=1_200, seed=0):
    rng = np.random.default_rng(seed)
    return 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n))), rng.integers(1_000_000, 2_000_000, n)


def planted(n=1_200, seed=1):
    """Every volume spike is followed by a 2% jump; otherwise the price barely moves."""
    rng = np.random.default_rng(seed)
    spike = rng.random(n) < 0.2
    volume = rng.integers(1_000_000, 1_200_000, n) * np.where(spike, 4, 1)
    step = np.where(np.roll(spike, 1), 0.02, rng.normal(0, 0.001, n))
    step[0] = 0
    return 100 * np.cumprod(1 + step), volume


def test_each_fold_is_tested_only_on_bars_after_its_training_window(put_bars):
    put_bars("SPY", *random_walk())
    folds = model.validate("SPY", FAST)["metrics"]["folds"]
    for earlier, later in zip(folds, folds[1:]):
        assert later["test_from"] > earlier["test_to"]
        assert later["train_rows"] == earlier["train_rows"] + earlier["test_rows"]  # training window grows
    assert len(db.query("SELECT ts FROM predictions")) == sum(f["test_rows"] for f in folds)  # one per tested bar


def test_a_random_walk_shows_no_edge(put_bars):
    put_bars("SPY", *random_walk())
    summary = model.validate("SPY", FAST)["metrics"]["summary"]
    assert summary["verdict"] != "better than the baselines"
    assert summary["scores"]["model"]["balanced_accuracy"] < 0.45  # leakage would push this far up


def test_a_planted_pattern_is_found(put_bars):
    put_bars("SPY", *planted())
    metrics = model.validate("SPY", FAST)["metrics"]
    assert metrics["summary"]["verdict"] == "better than the baselines"
    assert metrics["backtest"]["hit_rate"] > 0.9


def test_backtest_charges_costs_on_each_change_of_position():
    close = pd.Series([100.0, 110.0, 121.0, 133.1, 146.41], index=[0, 1, 2, 3, 4])
    oos = pd.DataFrame({"pred": [1, 1, 1, 1]}, index=[0, 1, 2, 3])
    free = model.backtest(oos, close, Params(cost_bps=0))
    assert free["strategy"]["total_return"] == pytest.approx(1.1**4 - 1)
    assert free["buy_hold"]["total_return"] == pytest.approx(1.1**4 - 1)
    costly = model.backtest(oos, close, Params(cost_bps=100))  # one entry at 1%
    assert costly["strategy"]["total_return"] == pytest.approx(1.09 * 1.1**3 - 1)
    flip = model.backtest(pd.DataFrame({"pred": [1, 0, 1, 0]}, index=[0, 1, 2, 3]), close, Params(cost_bps=0))
    assert (flip["trades"], flip["exposure"]) == (2, 0.5)
    assert flip["curve"]["t"] == [1, 2, 3, 4]  # each return lands on the bar it was earned by


def test_track_record_counts_hits_by_confidence_band():
    oos = pd.DataFrame({"pred": [1, 1, 1, -1], "conf": [0.42, 0.43, 0.7, 0.5], "actual": [1, 0, 1, -1]})
    record = model.track_record(oos)
    assert {"signal": "BUY", "from": 0.4, "to": 0.45, "n": 2, "right": 1} in record
    assert {"signal": "BUY", "from": 0.6, "to": 1.0, "n": 1, "right": 1} in record
    assert {"signal": "SELL", "from": 0.5, "to": 0.55, "n": 1, "right": 1} in record


def test_too_little_history_is_refused(put_bars):
    put_bars("SPY", *random_walk(n=150))
    with pytest.raises(ModelError, match="Not enough history"):
        model.validate("SPY", FAST)


def test_the_first_signal_shown_for_a_bar_is_kept(put_bars):
    put_bars("SPY", *random_walk())
    first = model.live_signal("SPY", "1d")  # trains and activates a default model
    again = model.live_signal("SPY", "1d")
    assert (first["ts"], first["signal"]) == (again["ts"], again["signal"])
    assert len(db.query("SELECT * FROM signals")) == 1
    assert len(db.query("SELECT * FROM models WHERE active = 1")) == 1
    assert set(first["indicators"]) == {"rsi", "ema_spread", "vol_z", "pct_b", "bb_width"}


def test_only_one_run_is_active(put_bars):
    put_bars("SPY", *random_walk())
    first = model.activate(model.validate("SPY", FAST)["id"])
    second = model.activate(model.validate("SPY", Params(trees=20, max_depth=2))["id"])
    assert model.active("SPY", "1d")["id"] == second["id"] != first["id"]


def test_live_record_grades_signals_once_the_next_bar_closes(put_bars):
    put_bars("SPY", [100.0, 101.0, 100.0])
    rows = [("SPY", "1d", 1_600_000_000, 10_000, "BUY"), ("SPY", "1d", 1_600_086_400, 10_100, "BUY"),
            ("SPY", "1d", 1_600_172_800, 10_000, "HOLD")]
    with db.tx() as conn:
        conn.execute("INSERT INTO models (id, symbol, interval, params, metrics) VALUES (1, 'SPY', '1d', '{}', '{}')")
        conn.executemany("INSERT INTO signals VALUES (?, ?, ?, ?, ?, 0.5, 0.5, 0.3, 0.2, 1)", rows)
    # +1% (right), -1% (wrong), and the last one has no next bar yet
    assert model.live_record("SPY", "1d", 0.005) == {"n": 2, "right": 1}


def test_live_record_compares_closes_across_a_split(put_bars):
    put_bars("SPY", [50.0, 50.5])  # split-adjusted: $100.00 and $101.00 before a 2-for-1 split on the second day
    with db.tx() as conn:
        conn.execute("INSERT INTO models (id, symbol, interval, params, metrics) VALUES (1, 'SPY', '1d', '{}', '{}')")
        conn.execute("INSERT INTO signals VALUES ('SPY', '1d', 1600000000, 10000, 'BUY', 0.5, 0.5, 0.3, 0.2, 1)")
        conn.execute("INSERT INTO splits (symbol, ts, ratio) VALUES ('SPY', 1600086400, 2.0)")
    assert model.live_record("SPY", "1d", 0.005) == {"n": 1, "right": 1}  # +1%, not -49.5%
