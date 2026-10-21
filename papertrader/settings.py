"""User settings, kept as JSON values in SQLite. The API validates them before they get here."""

import json

from . import db, ledger

DEFAULTS = {
    "commission_cents": 0,
    "commission_bps": 0,
    "slippage_bps": 0,
    "practice_mode": False,  # fill market orders at the last price while the market is closed
    "confirm_orders": True,
    "check_updates": True,  # one request to GitHub per start
    "theme": "system",
    "updown": "green-red",
    "account_id": None,
    "chart": {},  # the chart's own choices, stored as the UI sends them
    "lab": {},
}


def get():
    stored = {row["key"]: json.loads(row["value"]) for row in db.query("SELECT key, value FROM settings")}
    return {**DEFAULTS, **{key: value for key, value in stored.items() if key in DEFAULTS}}


def update(changes):
    with db.tx() as conn:
        conn.executemany(
            "INSERT INTO settings VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [(key, json.dumps(value)) for key, value in changes.items() if key in DEFAULTS],
        )
    return get()


def costs():
    s = get()
    return ledger.Costs(s["commission_cents"], s["commission_bps"], s["slippage_bps"])
