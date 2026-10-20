import os
import sqlite3
import sys
from contextlib import closing, contextmanager
from pathlib import Path

ROOT = Path(__file__).parent


def _data_dir():
    if os.environ.get("PAPERTRADER_DATA"):
        return Path(os.environ["PAPERTRADER_DATA"])
    if getattr(sys, "frozen", False):  # the installed app's own folder is read-only
        return Path(os.environ["LOCALAPPDATA"]) / "PaperTrader"
    return ROOT.parent / "data"


DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "papertrader.db"


def connect():
    # autocommit mode: writes open their transaction explicitly in tx()
    conn = sqlite3.connect(DB_PATH, timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def tx():
    """All-or-nothing write. BEGIN IMMEDIATE takes the write lock before anything is read,
    so two orders can never both see the same cash."""
    with closing(connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def query(sql, params=()):
    with closing(connect()) as conn:
        return [dict(row) for row in conn.execute(sql, params)]


def init():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as conn:
        conn.execute("PRAGMA journal_mode = WAL")  # readers never wait for a writer
        if conn.execute("PRAGMA user_version").fetchone()[0] == 0:
            try:
                conn.executescript("BEGIN;" + (ROOT / "schema.sql").read_text(encoding="utf-8") + "COMMIT;")
            except sqlite3.Error:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
