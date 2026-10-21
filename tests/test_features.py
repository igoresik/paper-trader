import math

import numpy as np
import pandas as pd
import pytest

from papertrader import db, features
from papertrader.features import Params


def series(values):
    return pd.Series(values, dtype=float)


def random_walk(n, seed=0):
    rng = np.random.default_rng(seed)
    close = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, n))))
    volume = pd.Series(rng.integers(1_000_000, 5_000_000, n), dtype=float)
    return close, volume


def test_rsi_matches_a_hand_computed_example():
    rsi = features.indicators(series([10, 11, 12, 11, 13]), series([1] * 5), Params(rsi=3))["rsi"]
    assert rsi.iloc[:3].isna().all()
    assert rsi.iloc[3] == pytest.approx(200 / 3)  # average gain 2/3, average loss 1/3
    assert rsi.iloc[4] == pytest.approx(250 / 3)  # Wilder smoothing: 10/9 against 2/9


def test_bollinger_percent_b_and_width_are_two_numbers():
    table = features.indicators(series([10, 10, 10, 12]), series([1] * 4), Params(bb=4))
    sd = math.sqrt(0.75)  # population std of 10, 10, 10, 12
    assert table["pct_b"].iloc[3] == pytest.approx((12 - (10.5 - 2 * sd)) / (4 * sd))
    assert table["bb_width"].iloc[3] == pytest.approx(4 * sd / 10.5)


def test_ema_spread_is_measured_per_dollar():
    close, volume = random_walk(200)
    cheap = features.indicators(close, volume)["ema_spread"]
    dear = features.indicators(close * 10, volume)["ema_spread"]
    pd.testing.assert_series_equal(cheap, dear)


def test_features_never_look_ahead():
    close, volume = random_walk(400)
    volume.iloc[300:] *= 10  # a later regime that whole-history statistics would leak backwards
    for p in (Params(), Params(context=True, regime=True)):
        full = features.indicators(close, volume, p)
        early = features.indicators(close[:300], volume[:300], p)
        pd.testing.assert_frame_equal(full.iloc[:300], early)


def test_labels_use_the_threshold_both_ways():
    y = features.labels(series([100, 101, 100.9, 100, 100.4]), 0.005)
    assert y.iloc[:4].tolist() == [1, 0, -1, 0]  # +1%, -0.1%, -0.9%, +0.4%
    assert np.isnan(y.iloc[4])  # tomorrow is unknown


def test_build_fills_the_feature_store(monkeypatch):
    close, volume = random_walk(60)
    db_rows = [("SPY", "1d", 86_400 * i, int(c * 100), int(c * 100), int(c * 100), int(c * 100), int(v))
               for i, (c, v) in enumerate(zip(close, volume))]
    with db.tx() as conn:
        conn.executemany("INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)", db_rows)
    features.build("SPY", "1d")
    stored = db.query("SELECT * FROM features WHERE symbol = 'SPY' ORDER BY ts")
    assert len(stored) == 60
    assert stored[0]["rsi"] is None  # warming up
    assert all(stored[-1][name] is not None for name in features.COLUMNS)


def test_market_context_adds_momentum_and_the_columns_it_is_given():
    close, volume = random_walk(60)
    plain = features.indicators(close, volume, Params())
    assert list(plain.columns) == features.COLUMNS  # runs from before context stay as they were
    context = pd.DataFrame({"vix": 20.0, "vix_change": 0.1, "yield_change": -0.05}, index=close.index)
    table = features.indicators(close, volume, Params(context=True), context)
    assert table["ret_5"].iloc[10] == pytest.approx(close.iloc[10] / close.iloc[5] - 1)
    assert {"vix", "vix_change", "yield_change"} <= set(table.columns)
    assert "vix" not in features.indicators(close, volume, Params(context=True), None).columns


def test_regime_inputs_measure_moves_in_units_of_recent_volatility():
    close, volume = random_walk(200)
    assert "vol_ratio" not in features.indicators(close, volume, Params()).columns  # older runs stay as they were
    table = features.indicators(close, volume, Params(regime=True))
    step = close.pct_change()
    assert table["vol_ratio"].iloc[150] == pytest.approx(step.iloc[146:151].std() / step.iloc[91:151].std())
    assert table["ret_z"].iloc[150] == pytest.approx(step.iloc[150] / step.iloc[131:151].std())
    calm, wild = features.indicators(close, volume, Params(regime=True)), features.indicators(
        close.iloc[0] * (close / close.iloc[0]) ** 3, volume, Params(regime=True))  # same path, three times the swings
    assert wild["ret_5_z"].iloc[150] == pytest.approx(calm["ret_5_z"].iloc[150], rel=0.1)


def test_a_move_counts_as_big_when_it_beats_the_usual_size_known_before_it():
    close = series([100, 101, 100, 101, 104, 104.1])  # moves: 1%, ~1%, 1%, ~3%, ~0.1%
    labels, usual = features.move_labels(close, window=3)
    assert labels.iloc[:3].isna().all()  # no usual size yet
    assert usual.iloc[3] == pytest.approx(0.0099, abs=1e-3)
    assert list(labels.iloc[3:5]) == [1.0, -1.0] and np.isnan(labels.iloc[5])  # then +3% is big, +0.1% is not


def test_a_barrier_call_is_whichever_barrier_the_close_reaches_first():
    steps = [0.01, -0.01] * 15  # 1% swings, so the 20-bar volatility is about 1% and a 4-bar barrier about 2%
    close = series(100 * np.cumprod(1 + np.array([0, *steps, 0.015, 0.01, -0.01, -0.03, 0.001, 0.001, 0.001, 0.001, 0.001])))
    labels = features.barrier_labels(close, 4)
    assert labels.iloc[:20].isna().all()  # no volatility yet
    assert labels.iloc[30] == 1  # +1.5% then +1%: up 2.5% before any fall
    assert labels.iloc[32] == -1  # -1% then -3%
    assert labels.iloc[35] == 0  # four quiet bars: neither barrier
    assert labels.iloc[-4:].isna().all()  # the bars that would decide it haven't happened
