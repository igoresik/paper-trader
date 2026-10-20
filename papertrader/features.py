"""Indicators and labels for the model. Every value at bar t uses only bars up to t."""

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import db, market

COLUMNS = ["rsi", "ema_spread", "vol_z", "pct_b", "bb_width"]


@dataclass(frozen=True)
class Params:
    rsi: int = 14
    ema_fast: int = 12
    ema_slow: int = 26
    bb: int = 20
    bb_k: float = 2.0
    vol: int = 20


def wilder(x, n):
    """Wilder's smoothing, seeded with the plain mean of the first n values (x[0] is the diff's NaN)."""
    seeded = x.copy()
    seeded.iloc[: n + 1] = np.nan
    if len(x) > n:
        seeded.iloc[n] = x.iloc[1 : n + 1].mean()
    return seeded.ewm(alpha=1 / n, adjust=False, ignore_na=True).mean()


def ema(close, span):
    return close.ewm(span=span, adjust=False, min_periods=span).mean()


def rsi(close, n):
    delta = close.diff()
    return 100 - 100 / (1 + wilder(delta.clip(lower=0), n) / wilder((-delta).clip(lower=0), n))


def bollinger(close, n, k):
    """Middle band and the distance from it to either outer band."""
    return close.rolling(n).mean(), k * close.rolling(n).std(ddof=0)


def macd(close, fast, slow, signal):
    line = ema(close, fast) - ema(close, slow)
    trigger = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return line, trigger, line - trigger


def indicators(close, volume, p=Params()):
    """Feature table for these closes and volumes (float Series on one index)."""
    mid, band = bollinger(close, p.bb, p.bb_k)
    # rolling, not whole-history, mean and std: those would leak later volume into earlier rows
    vol_z = (volume - volume.rolling(p.vol).mean()) / volume.rolling(p.vol).std(ddof=0)
    table = pd.DataFrame({
        "rsi": rsi(close, p.rsi),
        "ema_spread": (ema(close, p.ema_fast) - ema(close, p.ema_slow)) / close,  # per dollar, so years compare
        "vol_z": vol_z,
        "pct_b": (close - mid + band) / (2 * band),
        "bb_width": 2 * band / mid,
    })
    return table.replace([np.inf, -np.inf], np.nan)


def labels(close, threshold):
    """1 = BUY (next close more than threshold higher), -1 = SELL (that much lower), 0 = HOLD. NaN on the last bar."""
    change = close.shift(-1) / close - 1
    label = np.select([change > threshold, change < -threshold], [1, -1], 0)
    return pd.Series(label, index=close.index, dtype=float).where(change.notna())


def build(symbol, interval, p=Params()):
    """Recompute the feature store rows for one symbol from its stored bars."""
    bars = market.frame(symbol, interval)
    table = indicators(bars["close"], bars["volume"], p)
    rows = [
        (symbol, interval, int(ts), *(None if np.isnan(v) else float(v) for v in values))
        for ts, values in zip(table.index, table[COLUMNS].to_numpy())
    ]
    with db.tx() as conn:
        conn.execute("DELETE FROM features WHERE symbol = ? AND interval = ?", (symbol, interval))
        conn.executemany("INSERT INTO features VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return table
