"""The Discover view's data: one batched Yahoo download for the whole list, kept for a few minutes."""

import threading
import time

import yfinance as yf

from . import market
from .universe import CATEGORIES, UNIVERSE

TTL = 600  # seconds a download is reused; the live quotes of watched symbols come from the stream, not from here
_lock = threading.Lock()
_kept = {"at": 0.0, "items": []}


def _download(symbols):  # swapped for a fake in tests
    return yf.download(symbols, period="1y", interval="1d", group_by="ticker", auto_adjust=False, progress=False,
                       threads=True)


def _item(entry, closes):
    closes = closes.dropna()
    if len(closes) < 2:
        return None
    last, prev = float(closes.iloc[-1]), float(closes.iloc[-2])
    if last <= 0 or prev <= 0:
        return None

    def since(back):
        return last / float(closes.iloc[-1 - back]) - 1 if len(closes) > back else None

    return {**entry, "price_cents": market.cents(last), "day": last / prev - 1, "month": since(21),
            "year": last / float(closes.iloc[0]) - 1 if len(closes) > 200 else None,
            "spark": [round(float(c), 2) for c in closes.iloc[-22:]]}


def _fetch():
    symbols = [entry["symbol"] for entry in UNIVERSE]
    try:
        data = _download(symbols)
    except Exception as error:
        market._failed()
        raise market.MarketError(market.OFFLINE) from error
    market._answered()
    have = set(data.columns.get_level_values(0)) if len(data.columns) else set()
    items = [item for entry in UNIVERSE if entry["symbol"] in have
             if (item := _item(entry, data[entry["symbol"]]["Close"]))]
    if not items:
        raise market.MarketError(market.OFFLINE)
    return items


def snapshot(now=None):
    """Every listed symbol with its price, day, month and year change and a month of closes, plus the categories
    that have at least one symbol. A failed download falls back to the last good one, however old."""
    now = time.time() if now is None else now
    with _lock:
        if not _kept["items"] or now - _kept["at"] > TTL:
            try:
                _kept.update(at=now, items=_fetch())
            except market.MarketError:
                if not _kept["items"]:
                    raise
        items = _kept["items"]
        at = _kept["at"]
    counts = {c[0]: sum(c[0] in item["categories"] for item in items) for c in CATEGORIES}
    return {"updated": int(at),
            "categories": [{"id": i, "label": label, "blurb": blurb, "count": counts[i]}
                           for i, label, blurb in CATEGORIES if counts[i]],
            "items": items}
