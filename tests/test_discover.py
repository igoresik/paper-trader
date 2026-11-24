import numpy as np
import pandas as pd
import pytest

from papertrader import discover, market
from papertrader.universe import CATEGORIES, UNIVERSE


@pytest.fixture(autouse=True)
def forget():
    discover._kept.update(at=0.0, items=[])


def download(closes_by_symbol):
    """What yf.download gives for several symbols: one column block per symbol."""
    days = pd.bdate_range("2026-01-01", periods=max(len(c) for c in closes_by_symbol.values()))
    columns = {}
    for symbol, closes in closes_by_symbol.items():
        padded = [np.nan] * (len(days) - len(closes)) + list(closes)
        for field in ("Open", "High", "Low", "Close", "Volume"):
            columns[(symbol, field)] = padded
    return pd.DataFrame(columns, index=days)


def serve(monkeypatch, closes_by_symbol):
    calls = []
    monkeypatch.setattr(discover, "_download", lambda symbols: calls.append(symbols) or download(closes_by_symbol))
    return calls


def test_the_list_has_no_repeats_and_only_known_categories():
    symbols = [entry["symbol"] for entry in UNIVERSE]
    assert len(symbols) == len(set(symbols))
    known = {c[0] for c in CATEGORIES}
    assert all(entry["categories"] and set(entry["categories"]) <= known for entry in UNIVERSE)


def test_snapshot_computes_changes_and_leaves_out_symbols_yahoo_does_not_know(monkeypatch):
    year = [100.0 + i for i in range(250)]  # 100 ... 349
    serve(monkeypatch, {"AAPL": year, "MSFT": [50.0, 55.0]})
    shot = discover.snapshot(now=1000)
    by = {item["symbol"]: item for item in shot["items"]}
    assert set(by) == {"AAPL", "MSFT"}
    aapl = by["AAPL"]
    assert aapl["price_cents"] == 34_900
    assert aapl["day"] == pytest.approx(349 / 348 - 1)
    assert aapl["month"] == pytest.approx(349 / 328 - 1)
    assert aapl["year"] == pytest.approx(349 / 100 - 1)
    assert len(aapl["spark"]) == 22 and aapl["spark"][-1] == 349.0
    assert by["MSFT"]["month"] is None and by["MSFT"]["year"] is None  # too little history to say
    assert shot["updated"] == 1000


def test_only_categories_with_symbols_are_listed_with_their_counts(monkeypatch):
    serve(monkeypatch, {"AAPL": [1.0, 2.0], "MSFT": [1.0, 2.0], "JPM": [1.0, 2.0]})
    cats = {c["id"]: c["count"] for c in discover.snapshot(now=1)["categories"]}
    assert cats == {"tech": 2, "ai": 1, "software": 1, "finance": 1, "dividend": 1}


def test_a_download_is_reused_until_it_is_old(monkeypatch):
    calls = serve(monkeypatch, {"AAPL": [1.0, 2.0]})
    discover.snapshot(now=100)
    discover.snapshot(now=100 + discover.TTL)
    assert len(calls) == 1
    discover.snapshot(now=100 + discover.TTL + 1)
    assert len(calls) == 2


def test_a_failed_download_falls_back_to_the_last_good_one(monkeypatch):
    serve(monkeypatch, {"AAPL": [1.0, 2.0]})
    first = discover.snapshot(now=0)

    def broken(symbols):
        raise OSError("offline")

    monkeypatch.setattr(discover, "_download", broken)
    assert discover.snapshot(now=10_000)["items"] == first["items"]


def test_with_nothing_to_fall_back_on_a_failed_download_is_an_offline_error(monkeypatch):
    def broken(symbols):
        raise OSError("offline")

    monkeypatch.setattr(discover, "_download", broken)
    with pytest.raises(market.MarketError, match="Yahoo"):
        discover.snapshot()
