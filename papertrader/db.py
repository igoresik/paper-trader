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


# schema.sql is version 1; each step here moves a database up one version, so installed copies keep their data
UPGRADES = [
    """
    -- splits Yahoo marked on the first day at the new price, and when held shares and open orders moved with them
    CREATE TABLE splits (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL, -- start of that day
        ratio REAL NOT NULL CHECK (ratio > 0), -- new shares per old one: 10 for 10-for-1, 0.1 for 1-for-10
        applied_at INTEGER,
        PRIMARY KEY (symbol, ts)
    ) WITHOUT ROWID;
    -- what each split did to a portfolio; the ledger holds whole shares, so a leftover fraction is paid in cash
    CREATE TABLE split_changes (
        account_id INTEGER NOT NULL REFERENCES accounts (id),
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ratio REAL NOT NULL,
        shares_before INTEGER NOT NULL,
        shares_after INTEGER NOT NULL,
        cash_cents INTEGER NOT NULL CHECK (cash_cents >= 0),
        PRIMARY KEY (account_id, symbol, ts)
    ) WITHOUT ROWID;
    PRAGMA user_version = 2;
    """,
    """
    -- what slippage cost each fill, for the trader's report card (fills from before this step show 0)
    ALTER TABLE trades ADD COLUMN slippage_cents INTEGER NOT NULL DEFAULT 0 CHECK (slippage_cents >= 0);
    PRAGMA user_version = 3;
    """,
]


def _run(conn, script):
    try:
        conn.executescript("BEGIN;" + script + "COMMIT;")
    except sqlite3.Error:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def init():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as conn:
        conn.execute("PRAGMA journal_mode = WAL")  # readers never wait for a writer
        if conn.execute("PRAGMA user_version").fetchone()[0] == 0:
            _run(conn, (ROOT / "schema.sql").read_text(encoding="utf-8"))
        for script in UPGRADES[conn.execute("PRAGMA user_version").fetchone()[0] - 1:]:
            _run(conn, script)
