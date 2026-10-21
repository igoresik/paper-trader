"""Next-bar direction model: walk-forward validation against naive baselines, a long-only backtest, and live signals."""

import json
import threading
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import accuracy_score, balanced_accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import TimeSeriesSplit

from . import db, features, market

CLASSES = [-1, 0, 1]
NAMES = {-1: "SELL", 0: "HOLD", 1: "BUY"}
CODES = {name: code for code, name in NAMES.items()}
BANDS = [0.0, 0.4, 0.45, 0.5, 0.55, 0.6, 1.0]  # confidence bands for the track record
PER_YEAR = {"1d": 252, "1h": 252 * 7}
MIN_ROWS = 250
# balanced-accuracy margins over the best baseline: within NOISE is no edge, past CLEAR is a real one
NOISE, CLEAR = 0.02, 0.05
MIN_CALLS = 30  # fewer out-of-sample calls than this in a band prove too little either way


class ModelError(Exception):
    status = 400
    code = "model"


@dataclass(frozen=True)
class Params:
    interval: str = "1d"
    threshold: float = 0.005
    estimator: str = "random_forest"  # or gradient_boosting, which overfit SPY much more in walk-forward tests
    trees: int = 200
    max_depth: int = 3
    learning_rate: float = 0.05  # gradient boosting only
    min_leaf: int = 20
    folds: int = 5
    min_confidence: float = 0.0
    cost_bps: float = 5.0  # charged on every change of position in the backtest
    indicators: features.Params = field(default_factory=features.Params)

    @classmethod
    def load(cls, values):
        values = dict(values)
        indicators = features.Params(**values.pop("indicators", {}))
        return cls(**values, indicators=indicators)


def defaults(interval):
    return Params(interval=interval, threshold=0.005 if interval == "1d" else 0.002)


def _estimator(p):
    if p.estimator == "random_forest":
        return RandomForestClassifier(
            n_estimators=p.trees, max_depth=p.max_depth, min_samples_leaf=p.min_leaf,
            class_weight="balanced_subsample", n_jobs=-1, random_state=0,
        )
    return HistGradientBoostingClassifier(
        max_iter=p.trees, max_depth=p.max_depth, learning_rate=p.learning_rate, min_samples_leaf=p.min_leaf,
        class_weight="balanced", random_state=0,
    )


def _proba(model, X):
    """Probabilities in SELL, HOLD, BUY order, even when a training window lacked a class."""
    out = np.zeros((len(X), 3))
    out[:, [CLASSES.index(int(c)) for c in model.classes_]] = model.predict_proba(X)
    return out


def _decide(proba, min_confidence):
    pick, conf = np.array(CLASSES)[proba.argmax(axis=1)], proba.max(axis=1)
    unsure = conf < min_confidence
    return np.where(unsure, 0, pick), np.where(unsure, proba[:, 1], conf)


def dataset(symbol, p):
    bars = market.frame(symbol, p.interval)
    return bars, features.indicators(bars["close"], bars["volume"], p.indicators), features.labels(bars["close"], p.threshold)


def _scores(actual, pred):
    return {"accuracy": accuracy_score(actual, pred), "balanced_accuracy": balanced_accuracy_score(actual, pred)}


def walk_forward(X, y, p, progress=None):
    """Train on the past, test on the next block, roll forward. Never a random split: that would leak the future."""
    known = X.notna().all(axis=1) & y.notna()
    Xk, yk = X[known], y[known].astype(int)
    if len(yk) < MIN_ROWS:
        raise ModelError(f"Not enough history to validate: {len(yk)} usable bars, {MIN_ROWS} needed.")
    yesterday = yk.shift(1)  # the previous bar's label is already known when predicting
    folds, parts = [], []
    for k, (train, test) in enumerate(TimeSeriesSplit(n_splits=p.folds).split(Xk), 1):
        model = _estimator(p).fit(Xk.iloc[train], yk.iloc[train])
        proba = _proba(model, Xk.iloc[test])
        pred, conf = _decide(proba, p.min_confidence)
        actual = yk.iloc[test].to_numpy()
        part = pd.DataFrame(
            {"pred": pred, "conf": conf, "actual": actual, "majority": int(yk.iloc[train].mode()[0]),
             "always_buy": 1, "yesterday": yesterday.iloc[test].to_numpy().astype(int)},
            index=Xk.index[test],
        )
        folds.append({
            "fold": k, "train_rows": len(train), "test_rows": len(test),
            "test_from": int(Xk.index[test[0]]), "test_to": int(Xk.index[test[-1]]),
            **_scores(actual, pred),
            "macro_f1": f1_score(actual, pred, labels=CLASSES, average="macro", zero_division=0),
            "train_balanced_accuracy": balanced_accuracy_score(
                yk.iloc[train], _decide(_proba(model, Xk.iloc[train]), p.min_confidence)[0]
            ),
            "baselines": {name: accuracy_score(actual, part[name]) for name in ("majority", "always_buy", "yesterday")},
        })
        parts.append(part)
        if progress:
            progress(k / (p.folds + 1))
    return folds, pd.concat(parts), (model, Xk.iloc[test], yk.iloc[test])


def summarize(folds, oos):
    scores = {name: _scores(oos["actual"], oos[col]) for name, col in
              (("model", "pred"), ("majority", "majority"), ("always_buy", "always_buy"), ("yesterday", "yesterday"))}
    best = max(scores[name]["balanced_accuracy"] for name in ("majority", "always_buy", "yesterday"))
    edge = scores["model"]["balanced_accuracy"] - best
    if edge > CLEAR:
        verdict = "better than the baselines"
    elif edge > NOISE:
        verdict = "slightly better than the baselines"
    elif edge >= -NOISE:
        verdict = "no better than the baselines"
    else:
        verdict = "worse than the baselines"
    fold_bal = [f["balanced_accuracy"] for f in folds]
    return {"scores": scores, "edge": edge, "verdict": verdict,
            "fold_balanced_accuracy": {"mean": float(np.mean(fold_bal)), "std": float(np.std(fold_bal))}}


def _performance(returns, equity, per_year):
    years = len(returns) / per_year
    std = returns.std()
    return {
        "total_return": float(equity[-1] - 1),
        "cagr": float(equity[-1] ** (1 / years) - 1) if equity[-1] > 0 else -1.0,
        "sharpe": float(returns.mean() / std * np.sqrt(per_year)) if std > 0 else 0.0,
        "max_drawdown": float((equity / np.maximum.accumulate(equity) - 1).min()),
    }


def backtest(oos, close, p):
    """Long when the signal says BUY, flat otherwise (no shorting), against buy-and-hold over the same bars."""
    ahead = close.shift(-1) / close - 1
    r = ahead.reindex(oos.index).to_numpy()
    held = (oos["pred"].to_numpy() == 1).astype(float)
    switches = np.abs(np.diff(np.concatenate([[0.0], held])))
    strategy = held * r - switches * p.cost_bps / 10_000
    curve_s, curve_h = np.cumprod(1 + strategy), np.cumprod(1 + r)
    after = pd.Series(close.index[1:], index=close.index[:-1]).reindex(oos.index)  # each return lands on the next bar
    buys = held == 1
    return {
        "strategy": _performance(strategy, curve_s, PER_YEAR[p.interval]),
        "buy_hold": _performance(r, curve_h, PER_YEAR[p.interval]),
        "exposure": float(held.mean()),
        "trades": int(((held == 1) & (np.concatenate([[0.0], held[:-1]]) == 0)).sum()),
        "hit_rate": float((r[buys] > 0).mean()) if buys.any() else None,
        "curve": {"t": [int(t) for t in after], "strategy": (100 * curve_s).round(3).tolist(),
                  "buy_hold": (100 * curve_h).round(3).tolist()},
    }


def track_record(oos):
    """How often each signal was right out of sample, by confidence band."""
    record = []
    for code, name in NAMES.items():
        mine = oos[oos["pred"] == code]
        for low, high in zip(BANDS, BANDS[1:]):
            band = mine[(mine["conf"] >= low) & ((mine["conf"] < high) | (high == 1.0))]
            if len(band):
                record.append({"signal": name, "from": low, "to": high, "n": len(band),
                               "right": int((band["actual"] == code).sum())})
    return record


def _band(record, signal, confidence):
    return next((b for b in record if b["signal"] == signal and b["from"] <= confidence
                 and (confidence < b["to"] or b["to"] == 1.0)), None)


def _wilson_low(right, n, z=1.96):
    """Lower end of the 95% range for a hit rate of right/n, which stays honest for small n."""
    rate = right / n
    return (rate + z * z / (2 * n) - z * np.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def call(model_id, signal, confidence):
    """Whether a signal at this confidence has an edge: in its band, out of sample, it must have been right
    clearly more often than that outcome happens anyway. A 3-way guess that's 36% sure usually hasn't."""
    band = _band(run(model_id)["metrics"].get("track_record", []), signal, confidence)
    base = db.query("SELECT AVG(actual = ?) AS rate FROM predictions WHERE model_id = ?", (signal, model_id))[0]["rate"] or 0.0
    clear = bool(band and band["n"] >= MIN_CALLS and _wilson_low(band["right"], band["n"]) > base)
    return {"band": band, "base_rate": base, "clear": clear}


def validate(symbol, p, progress=None):
    """Run walk-forward validation and store the run (not active yet). Returns the run."""
    bars, X, y = dataset(symbol, p)
    folds, oos, (last_model, last_X, last_y) = walk_forward(X, y, p, progress)
    importance = permutation_importance(
        last_model, last_X, last_y, scoring="balanced_accuracy", n_repeats=5, random_state=0
    ).importances_mean
    metrics = {
        "summary": summarize(folds, oos),
        "folds": folds,
        "confusion": confusion_matrix(oos["actual"], oos["pred"], labels=CLASSES).tolist(),  # rows: actual SELL, HOLD, BUY
        "backtest": backtest(oos, bars["close"], p),
        "track_record": track_record(oos),
        "importance": dict(zip(features.COLUMNS, importance.round(4).tolist())),
        "rows": len(oos), "from": int(oos.index[0]), "to": int(oos.index[-1]),
    }
    with db.tx() as conn:
        model_id = conn.execute(
            "INSERT INTO models (symbol, interval, params, metrics) VALUES (?, ?, ?, ?)",
            (symbol, p.interval, json.dumps(asdict(p)), json.dumps(metrics, default=lambda v: v.item())),
        ).lastrowid
        conn.executemany(
            "INSERT INTO predictions VALUES (?, ?, ?, ?, ?)",
            [(model_id, int(ts), NAMES[int(r.pred)], float(r.conf), NAMES[int(r.actual)]) for ts, r in oos.iterrows()],
        )
    if progress:
        progress(1.0)
    return run(model_id)


def _run_row(row):
    return {**row, "params": json.loads(row["params"]), "metrics": json.loads(row["metrics"]), "active": bool(row["active"])}


def run(model_id):
    rows = db.query("SELECT * FROM models WHERE id = ?", (model_id,))
    if not rows:
        raise ModelError(f"There is no model run {model_id}.")
    return _run_row(rows[0])


def runs(symbol, interval):
    """Past runs, newest first, without the bulky curves."""
    found = []
    for row in db.query("SELECT * FROM models WHERE symbol = ? AND interval = ? ORDER BY id DESC", (symbol, interval)):
        item = _run_row(row)
        item["metrics"] = {"summary": item["metrics"]["summary"], "backtest": {
            k: v for k, v in item["metrics"]["backtest"].items() if k != "curve"}}
        found.append(item)
    return found


def active(symbol, interval):
    rows = db.query("SELECT * FROM models WHERE symbol = ? AND interval = ? AND active = 1", (symbol, interval))
    return _run_row(rows[0]) if rows else None


def activate(model_id):
    """Use this run for live signals. The feature store follows its indicator settings."""
    chosen = run(model_id)
    with db.tx() as conn:
        conn.execute("UPDATE models SET active = 0 WHERE symbol = ? AND interval = ? AND active = 1",
                     (chosen["symbol"], chosen["interval"]))
        conn.execute("UPDATE models SET active = 1 WHERE id = ?", (model_id,))
    features.build(chosen["symbol"], chosen["interval"], Params.load(chosen["params"]).indicators)
    return run(model_id)


_fitted = {}  # (symbol, interval) -> (model id, last bar, estimator); kept in memory only, never pickled
_fit_lock = threading.Lock()


def live_signal(symbol, interval):
    """Signal for the bar after the latest complete one. Trains and activates a default model the first time."""
    chosen = active(symbol, interval) or activate(validate(symbol, defaults(interval))["id"])
    p = Params.load(chosen["params"])
    bars, X, y = dataset(symbol, p)
    if X.iloc[-1].isna().any():
        raise ModelError("The latest bar doesn't have enough history for its indicators yet.")
    with _fit_lock:
        cached = _fitted.get((symbol, interval))
        if not cached or cached[:2] != (chosen["id"], bars.index[-1]):
            known = X.notna().all(axis=1) & y.notna()
            cached = (chosen["id"], bars.index[-1], _estimator(p).fit(X[known], y[known].astype(int)))
            _fitted[(symbol, interval)] = cached
    proba = _proba(cached[2], X.iloc[[-1]])
    pred, conf = _decide(proba, p.min_confidence)
    signal = {
        "symbol": symbol, "interval": interval, "ts": int(bars.index[-1]),
        "close_cents": int(round(bars["close"].iloc[-1] * 100)), "signal": NAMES[int(pred[0])],
        "confidence": float(conf[0]), "p_sell": float(proba[0, 0]), "p_hold": float(proba[0, 1]),
        "p_buy": float(proba[0, 2]), "model_id": chosen["id"],
        "indicators": {name: float(X[name].iloc[-1]) for name in features.COLUMNS},
    }
    with db.tx() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO signals VALUES (:symbol, :interval, :ts, :close_cents, :signal, :confidence,"
            " :p_buy, :p_hold, :p_sell, :model_id)",
            signal,
        )
    return signal


def live_record(symbol, interval, threshold):
    """How the signals shown live turned out, once the next bar closed."""
    rows = db.query(
        "SELECT s.ts, s.signal, s.close_cents, (SELECT b.close_cents FROM bars b WHERE b.symbol = s.symbol"
        " AND b.interval = s.interval AND b.ts > s.ts ORDER BY b.ts LIMIT 1) AS next_close"
        " FROM signals s WHERE s.symbol = ? AND s.interval = ?",
        (symbol, interval),
    )
    done = [r for r in rows if r["next_close"] is not None]
    right, factor = 0, market.split_factor(symbol)
    for r in done:
        # a signal keeps the close it was made at; the bars have been split-adjusted since
        change = r["next_close"] * factor(r["ts"]) / r["close_cents"] - 1
        actual = "BUY" if change > threshold else "SELL" if change < -threshold else "HOLD"
        right += actual == r["signal"]
    return {"n": len(done), "right": right}


def report(symbol, interval):
    """Everything the signal card shows: the signal, the indicators behind it and the model's record."""
    signal = live_signal(symbol, interval)
    chosen = run(signal["model_id"])
    m = chosen["metrics"]
    return {
        **signal,
        "model": {"id": chosen["id"], "created_at": chosen["created_at"], "estimator": chosen["params"]["estimator"],
                  "threshold": chosen["params"]["threshold"], "summary": m["summary"]},
        **call(chosen["id"], signal["signal"], signal["confidence"]),
        "live_record": live_record(symbol, interval, chosen["params"]["threshold"]),
    }
