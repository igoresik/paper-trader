"""Next-bar direction model: walk-forward validation against naive baselines, a long-only backtest, and live signals."""

import json
import threading
from dataclasses import asdict, dataclass, field, replace

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
MOVE = {-1: "QUIET", 1: "BIG"}  # the move reading: the next bar moves less, or more, than usual
BANDS = [0.0, 0.4, 0.45, 0.5, 0.55, 0.6, 1.0]  # confidence bands for the track record
PER_YEAR = {"1d": 252, "1h": 252 * 7}
MIN_ROWS = 250
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
    prune: bool = False  # drop inputs that don't help, picked inside each training window
    indicators: features.Params = field(default_factory=features.Params)

    @classmethod
    def load(cls, values):
        values = dict(values)
        indicators = features.Params(**values.pop("indicators", {}))
        return cls(**values, indicators=indicators)


def defaults(interval):
    return Params(interval=interval, threshold=0.005 if interval == "1d" else 0.002,
                  indicators=features.Params(context=True, regime=True))


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


def _inputs(X, y, p):
    """The columns to train on. With p.prune: fit on the first 80% of these rows and keep the inputs whose shuffling
    hurts the last 20%. Only training rows decide, so the bars it's tested on never pick its inputs."""
    if not p.prune:
        return list(X.columns)
    cut = int(len(X) * 0.8)
    trial = _estimator(p).fit(X.iloc[:cut], y.iloc[:cut])
    drop = permutation_importance(trial, X.iloc[cut:], y.iloc[cut:], scoring="balanced_accuracy", n_repeats=5,
                                  random_state=0).importances_mean
    return [c for c, v in zip(X.columns, drop) if v > 0] or [X.columns[int(drop.argmax())]]


def _fit(X, y, p):
    """A fitted model and the columns it reads."""
    cols = _inputs(X, y, p)
    return _estimator(p).fit(X[cols], y), cols


def _predict(fitted, X):
    model, cols = fitted
    return _proba(model, X[cols])


def _decide(proba, min_confidence):
    pick, conf = np.array(CLASSES)[proba.argmax(axis=1)], proba.max(axis=1)
    unsure = conf < min_confidence
    return np.where(unsure, 0, pick), np.where(unsure, proba[:, 1], conf)


def dataset(symbol, p):
    bars = market.frame(symbol, p.interval)
    context = market.context(bars.index, p.interval) if p.indicators.context else None
    X = features.indicators(bars["close"], bars["volume"], p.indicators, context)
    return bars, X, features.labels(bars["close"], p.threshold)


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
        fitted = _fit(Xk.iloc[train], yk.iloc[train], p)
        proba = _predict(fitted, Xk.iloc[test])
        pred, conf = _decide(proba, p.min_confidence)
        actual = yk.iloc[test].to_numpy()
        part = pd.DataFrame(
            {"pred": pred, "conf": conf, "p_buy": proba[:, 2], "p_sell": proba[:, 0], "actual": actual,
             "majority": int(yk.iloc[train].mode()[0]),
             "always_buy": 1, "yesterday": yesterday.iloc[test].to_numpy().astype(int)},
            index=Xk.index[test],
        )
        folds.append({
            "fold": k, "train_rows": len(train), "test_rows": len(test),
            "test_from": int(Xk.index[test[0]]), "test_to": int(Xk.index[test[-1]]),
            **_scores(actual, pred),
            "macro_f1": f1_score(actual, pred, labels=CLASSES, average="macro", zero_division=0),
            "train_balanced_accuracy": balanced_accuracy_score(
                yk.iloc[train], _decide(_predict(fitted, Xk.iloc[train]), p.min_confidence)[0]
            ),
            "inputs": fitted[1],
            "baselines": {name: accuracy_score(actual, part[name]) for name in ("majority", "always_buy", "yesterday")},
        })
        parts.append(part)
        if progress:
            progress(k / (p.folds + 1))
    return folds, pd.concat(parts), (fitted[0], Xk.iloc[test][fitted[1]], yk.iloc[test])


def _balanced(actual, pred):
    """Balanced accuracy of each row of (resamples x days) arrays: the mean recall over the classes present."""
    recalls = []
    for c in CLASSES:
        mask = actual == c
        n = mask.sum(axis=1)
        recalls.append(np.where(n > 0, (mask & (pred == c)).sum(axis=1) / np.maximum(n, 1), np.nan))
    return np.nanmean(recalls, axis=0)


def edge_range(oos, tries=1, resamples=2_000, block=20, seed=0):
    """Likely range for the edge over the best baseline, from resampling the out-of-sample days in blocks
    (neighbouring days move together, so single days would overstate the evidence). Each run tried on the
    same data is another chance to look good by luck, so the range widens with the number of tries."""
    n = len(oos)
    starts = np.random.default_rng(seed).integers(0, max(n - block, 0) + 1, (resamples, -(-n // block)))
    columns = {name: oos[name].to_numpy().astype(np.int8) for name in ("actual", "pred", "majority", "always_buy", "yesterday")}
    edges = []
    # 30 years of days times 2,000 resamples is too big for one array, so a batch at a time; same answer either way
    for batch in np.array_split(starts, max(1, resamples * n // 2_000_000)):
        days = np.minimum((batch[:, :, None] + np.arange(block)).reshape(len(batch), -1)[:, :n], n - 1)
        actual = columns["actual"][days]
        best = np.max([_balanced(actual, columns[name][days]) for name in ("majority", "always_buy", "yesterday")], axis=0)
        edges.append(_balanced(actual, columns["pred"][days]) - best)
    alpha = 0.05 / tries
    low, high = np.quantile(np.concatenate(edges), [alpha / 2, 1 - alpha / 2])
    return float(low), float(high)


def summarize(folds, oos, tries=1):
    scores = {name: _scores(oos["actual"], oos[col]) for name, col in
              (("model", "pred"), ("majority", "majority"), ("always_buy", "always_buy"), ("yesterday", "yesterday"))}
    best = max(scores[name]["balanced_accuracy"] for name in ("majority", "always_buy", "yesterday"))
    edge = scores["model"]["balanced_accuracy"] - best
    low, high = edge_range(oos, tries)
    # the range decides, not the edge on its own: a few points either way is what luck alone produces
    verdict = ("better than the baselines" if low > 0 else "worse than the baselines" if high < 0
               else "not clearly better than the baselines")
    fold_bal = [f["balanced_accuracy"] for f in folds]
    summary = {"scores": scores, "edge": edge, "edge_range": [low, high], "tries": tries, "verdict": verdict,
               "fold_balanced_accuracy": {"mean": float(np.mean(fold_bal)), "std": float(np.std(fold_bal))}}
    if (oos["actual"] == 0).any():  # a three-way model: score up against down on its own, where it called one
        called = oos[(oos["pred"] != 0) & (oos["actual"] != 0)]
        right = int((called["pred"] == called["actual"]).sum())
        summary["direction"] = {"n": len(called), "right": right,
                                "range": list(_wilson(right, len(called))) if len(called) else None}
    return summary


def _performance(returns, equity, per_year):
    years = len(returns) / per_year
    std = returns.std()
    return {
        "total_return": float(equity[-1] - 1),
        "cagr": float(equity[-1] ** (1 / years) - 1) if equity[-1] > 0 else -1.0,
        "sharpe": float(returns.mean() / std * np.sqrt(per_year)) if std > 0 else 0.0,
        "max_drawdown": float((equity / np.maximum.accumulate(equity) - 1).min()),
    }


def sizes(oos):
    """Share of the money to hold, from half to all of it, by where the model's lean towards up sits among its
    earlier out-of-sample leans: its own probabilities bunch together, so their rank spreads the sizes out."""
    lean = oos["p_buy"] / (oos["p_buy"] + oos["p_sell"])
    return (0.5 + 0.5 * lean.expanding(60).rank(pct=True)).fillna(0.75).to_numpy()


def _returns(weights, r, cost_bps):
    """Each bar's return holding these shares of the money, paying the cost on every change of holding."""
    switches = np.abs(np.diff(np.concatenate([[0.0], weights])))
    returns = weights * r - switches * cost_bps / 10_000
    return returns, np.cumprod(1 + returns)


def backtest(oos, close, p):
    """Long when the signal says BUY, flat otherwise (no shorting), against buy-and-hold over the same bars. Also
    sized by the model's lean, against holding its average size all the time: what sizing adds beyond being in."""
    ahead = close.shift(-1) / close - 1
    r = ahead.reindex(oos.index).to_numpy()
    held = (oos["pred"].to_numpy() == 1).astype(float)
    strategy, curve_s = _returns(held, r, p.cost_bps)
    curve_h = np.cumprod(1 + r)
    weights = sizes(oos)
    sized, curve_z = _returns(weights, r, p.cost_bps)
    steady, curve_c = _returns(np.full(len(r), weights.mean()), r, p.cost_bps)
    after = pd.Series(close.index[1:], index=close.index[:-1]).reindex(oos.index)  # each return lands on the next bar
    buys = held == 1
    return {
        "strategy": _performance(strategy, curve_s, PER_YEAR[p.interval]),
        "buy_hold": _performance(r, curve_h, PER_YEAR[p.interval]),
        "sized": _performance(sized, curve_z, PER_YEAR[p.interval]),
        "steady": _performance(steady, curve_c, PER_YEAR[p.interval]),
        "exposure": float(held.mean()),
        "sized_exposure": float(weights.mean()),
        "trades": int(((held == 1) & (np.concatenate([[0.0], held[:-1]]) == 0)).sum()),
        "hit_rate": float((r[buys] > 0).mean()) if buys.any() else None,
        "curve": {"t": [int(t) for t in after], "strategy": (100 * curve_s).round(3).tolist(),
                  "buy_hold": (100 * curve_h).round(3).tolist(), "sized": (100 * curve_z).round(3).tolist(),
                  "steady": (100 * curve_c).round(3).tolist()},
    }


def track_record(oos, names=NAMES):
    """How often each signal was right out of sample, by confidence band."""
    record = []
    for code, name in names.items():
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


def _wilson(right, n, z=1.96):
    """The 95% range for a hit rate of right/n, which stays honest for small n."""
    rate, centre = right / n, right / n + z * z / (2 * n)
    spread = z * np.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n))
    return float((centre - spread) / (1 + z * z / n)), float((centre + spread) / (1 + z * z / n))


def _clear(band, base):
    """A call counts when, in its confidence band, it was right clearly more often than its outcome happens anyway."""
    return bool(band and band["n"] >= MIN_CALLS and _wilson(band["right"], band["n"])[0] > base)


def call(model_id, signal, confidence):
    """Whether a signal at this confidence is a call on direction, judged on its band's out-of-sample calls. BUY and
    SELL have to get the direction right clearly more than half the time on the days that moved: a BUY is also right
    more often whenever big moves are likely, either way. HOLD never is: how big the move will be is the move
    reading's job, and two answers to that question could only contradict each other."""
    band = _band(run(model_id)["metrics"].get("track_record", []), signal, confidence)
    base = db.query("SELECT AVG(actual = ?) AS rate FROM predictions WHERE model_id = ?", (signal, model_id))[0]["rate"] or 0.0
    if signal == "HOLD" or not band:
        return {"band": band, "base_rate": base, "moved": None, "clear": False}
    moved = db.query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(actual = signal), 0) AS right FROM predictions WHERE model_id = ?"
        " AND signal = ? AND actual != 'HOLD' AND confidence >= ? AND (confidence < ? OR ? = 1.0)",
        (model_id, signal, band["from"], band["to"], band["to"]),
    )[0]
    return {"band": band, "base_rate": base, "moved": moved, "clear": _clear(moved, 0.5)}


def move_call(chosen, p_big):
    """The move reading for a probability that the next bar moves more than usual, judged like a signal."""
    m = chosen["metrics"]["move"]
    call_ = "BIG" if p_big >= 0.5 else "QUIET"
    confidence = max(p_big, 1 - p_big)
    band = _band(m["track_record"], call_, confidence)
    base = m["base_rate"] if call_ == "BIG" else 1 - m["base_rate"]
    return {"call": call_, "confidence": confidence, "band": band, "base_rate": base, "clear": _clear(band, base)}


def validate(symbol, p, progress=None):
    """Run walk-forward validation and store the run (not active yet). Returns the run."""
    bars, X, y = dataset(symbol, p)

    def part(start):  # each of the two models fills half the progress bar
        return (lambda done: progress(start + done / 2)) if progress else None

    folds, oos, (last_model, last_X, last_y) = walk_forward(X, y, p, part(0))
    big, _ = features.move_labels(bars["close"])
    move_folds, move_oos, _ = walk_forward(X, big, replace(p, min_confidence=0.0), part(0.5))
    importance = permutation_importance(
        last_model, last_X, last_y, scoring="balanced_accuracy", n_repeats=5, random_state=0
    ).importances_mean
    tries = db.query("SELECT COUNT(*) AS n FROM models WHERE symbol = ? AND interval = ?", (symbol, p.interval))[0]["n"] + 1
    metrics = {
        "summary": summarize(folds, oos, tries),
        "folds": folds,
        "confusion": confusion_matrix(oos["actual"], oos["pred"], labels=CLASSES).tolist(),  # rows: actual SELL, HOLD, BUY
        "backtest": backtest(oos, bars["close"], p),
        "track_record": track_record(oos),
        "importance": dict(zip(last_X.columns, importance.round(4).tolist())),
        "inputs": list(X.columns),  # every input on offer; with pruning each fold lists the ones it kept
        "rows": len(oos), "from": int(oos.index[0]), "to": int(oos.index[-1]),
        "move": {"summary": summarize(move_folds, move_oos, tries), "track_record": track_record(move_oos, MOVE),
                 "base_rate": float((move_oos["actual"] == 1).mean())},
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


_fitted = {}  # (symbol, interval) -> (model id, last bar, estimators); kept in memory only, never pickled
# (symbol, interval) -> the call last worked out. The signals table keeps the first one shown for each bar, for an
# honest live record; this is what the watchlist shows, so it follows a retested or newly chosen model
latest = {}
_fit_lock = threading.Lock()


def live_signal(symbol, interval):
    """Signal for the bar after the latest complete one. Trains and activates a default model the first time."""
    chosen = active(symbol, interval) or activate(validate(symbol, defaults(interval))["id"])
    p = Params.load(chosen["params"])
    if "move" not in chosen["metrics"]:  # tested before move readings existed: once more, with the same settings
        chosen = activate(validate(symbol, p)["id"])
    bars, X, y = dataset(symbol, p)
    big, usual = features.move_labels(bars["close"])
    if X.iloc[-1].isna().any():
        raise ModelError("The latest bar doesn't have enough history for its indicators yet.")
    with _fit_lock:
        cached = _fitted.get((symbol, interval))
        if not cached or cached[:2] != (chosen["id"], bars.index[-1]):
            known = X.notna().all(axis=1) & y.notna()
            moved = X.notna().all(axis=1) & big.notna()
            cached = (chosen["id"], bars.index[-1], _fit(X[known], y[known].astype(int), p),
                      _fit(X[moved], big[moved].astype(int), p))
            _fitted[(symbol, interval)] = cached
    proba = _predict(cached[2], X.iloc[[-1]])
    p_big = float(_predict(cached[3], X.iloc[[-1]])[0, 2])
    pred, conf = _decide(proba, p.min_confidence)
    signal = {
        "symbol": symbol, "interval": interval, "ts": int(bars.index[-1]),
        "close_cents": int(round(bars["close"].iloc[-1] * 100)), "signal": NAMES[int(pred[0])],
        "confidence": float(conf[0]), "p_sell": float(proba[0, 0]), "p_hold": float(proba[0, 1]),
        "p_buy": float(proba[0, 2]), "model_id": chosen["id"],
        "indicators": {name: float(X[name].iloc[-1]) for name in features.COLUMNS},
        "move": {"p_big": p_big, "usual": float(usual.iloc[-1]), **move_call(chosen, p_big)},
    }
    with db.tx() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO signals VALUES (:symbol, :interval, :ts, :close_cents, :signal, :confidence,"
            " :p_buy, :p_hold, :p_sell, :model_id)",
            signal,
        )
        conn.execute("INSERT OR IGNORE INTO move_signals VALUES (?, ?, ?, ?, ?, ?)",
                     (symbol, interval, signal["ts"], signal["move"]["usual"], p_big, chosen["id"]))
    latest[(symbol, interval)] = {k: signal[k] for k in ("symbol", "signal", "confidence", "ts", "model_id")} | {
        "clear": call(chosen["id"], signal["signal"], signal["confidence"])["clear"]}
    return signal


def move_record(symbol, interval):
    """How the live move readings turned out, once the next bar closed."""
    rows = db.query(
        "SELECT m.ts, m.usual, m.p_big, s.close_cents, (SELECT b.close_cents FROM bars b WHERE b.symbol = m.symbol"
        " AND b.interval = m.interval AND b.ts > m.ts ORDER BY b.ts LIMIT 1) AS next_close"
        " FROM move_signals m JOIN signals s USING (symbol, interval, ts) WHERE m.symbol = ? AND m.interval = ?",
        (symbol, interval),
    )
    done, factor = [r for r in rows if r["next_close"] is not None], market.split_factor(symbol)
    right = sum((r["p_big"] >= 0.5) == (abs(r["next_close"] * factor(r["ts"]) / r["close_cents"] - 1) > r["usual"])
                for r in done)
    return {"n": len(done), "right": right}


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


def follow(symbol, since, interval="1d"):
    """What going long after each live BUY signal, and staying out otherwise, made from since. Only bars that
    got a signal shown (the app was running) and whose next bar has closed count."""
    rows = db.query(
        "SELECT s.ts, s.signal, s.close_cents, (SELECT b.close_cents FROM bars b WHERE b.symbol = s.symbol"
        " AND b.interval = s.interval AND b.ts > s.ts ORDER BY b.ts LIMIT 1) AS next_close"
        " FROM signals s WHERE s.symbol = ? AND s.interval = ? AND s.ts >= ? ORDER BY s.ts",
        (symbol, interval, since),
    )
    done, factor = [r for r in rows if r["next_close"] is not None], market.split_factor(symbol)
    growth = np.prod([r["next_close"] * factor(r["ts"]) / r["close_cents"] for r in done if r["signal"] == "BUY"])
    return {"return": float(growth - 1), "days": len(done)}


def follow_oos(symbol, since, until, interval="1d"):
    """What following the active model's out-of-sample calls made between since and until: long after each
    BUY, out otherwise. These calls came from models that never trained on the day, so a replay can use them."""
    chosen = active(symbol, interval)
    if not chosen:
        return {"return": 0.0, "days": 0}
    rows = db.query(
        "SELECT p.signal, b.close_cents AS close, (SELECT n.close_cents FROM bars n WHERE n.symbol = b.symbol"
        " AND n.interval = b.interval AND n.ts > b.ts AND n.ts <= ? ORDER BY n.ts LIMIT 1) AS next_close"
        " FROM predictions p JOIN bars b ON b.symbol = ? AND b.interval = ? AND b.ts = p.ts"
        " WHERE p.model_id = ? AND p.ts >= ? AND p.ts < ?",
        (until, symbol, interval, chosen["id"], since, until),
    )
    done = [r for r in rows if r["next_close"] is not None]
    growth = np.prod([r["next_close"] / r["close"] for r in done if r["signal"] == "BUY"])
    return {"return": float(growth - 1), "days": len(done)}


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
        "move": {**signal["move"], "summary": m["move"]["summary"], "live_record": move_record(symbol, interval)},
    }
