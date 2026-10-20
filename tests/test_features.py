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
    full = features.indicators(close, volume)
    early = features.indicators(close[:300], volume[:300])
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
