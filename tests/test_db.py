import sqlite3
from contextlib import closing

from papertrader import db, ledger


def test_an_installed_copy_upgrades_and_keeps_its_data(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "old.db")
    with sqlite3.connect(db.DB_PATH) as conn:  # a database made by 0.1.0
        conn.executescript((db.ROOT / "schema.sql").read_text(encoding="utf-8"))
        conn.execute("INSERT INTO accounts (name, starting_cash_cents, cash_balance_cents) VALUES ('Main', 100, 100)")
    db.init()
    db.init()  # and again on the next start, which changes nothing
    assert db.query("PRAGMA user_version")[0]["user_version"] == len(db.UPGRADES) + 1
    assert ledger.account(1)["name"] == "Main"
    assert db.query("SELECT * FROM splits") == []
    with closing(sqlite3.connect(tmp_path / "old-v1-backup.db")) as copy:  # the database as 0.1.0 left it
        assert copy.execute("PRAGMA user_version").fetchone()[0] == 1
        assert copy.execute("SELECT name FROM accounts").fetchall() == [("Main",)]
    assert sorted(f.name for f in tmp_path.glob("*backup*")) == ["old-v1-backup.db"]


def test_a_new_database_makes_no_backup(tmp_path):
    assert not list(tmp_path.glob("*backup*"))
