import pytest

from papertrader import db, model


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init()
    model._fitted.clear()  # keyed by model id, which every fresh database starts again at 1
    model.latest.clear()


@pytest.fixture
def put_bars():
    """Store synthetic complete bars (dollar closes) for a symbol."""

    def put(symbol, closes, volumes=None, interval="1d", start=1_600_000_000, step=86_400):
        volumes = [1_000_000] * len(closes) if volumes is None else volumes
        with db.tx() as conn:
            conn.execute("INSERT OR IGNORE INTO symbols VALUES (?, ?, 'NYSE', 'EQUITY', 'USD')", (symbol, symbol))
            conn.executemany(
                "INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [(symbol, interval, start + i * step, round(c * 100), round(c * 100), round(c * 100), round(c * 100),
                  int(v)) for i, (c, v) in enumerate(zip(closes, volumes))],
            )

    return put
