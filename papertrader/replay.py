"""Replay: trade one symbol's past a day at a time, seeing only the bars up to the replay's clock."""

from . import db, ledger, market, model, settings


def _bars(symbol, after=-1, until=None):
    return db.query(
        "SELECT ts, open_cents AS open, high_cents AS high, low_cents AS low, close_cents AS close FROM bars"
        " WHERE symbol = ? AND interval = '1d' AND ts > ? AND ts <= ? ORDER BY ts",
        (symbol, after, until if until is not None else 2**62),
    )


def _replay(account_id):
    acct = ledger.account(account_id)
    if acct["replay_at"] is None:
        raise ledger.NotFound(f"There is no replay {account_id}.")
    return acct


def start(symbol, start_ts, cash):
    """Open a replay on the first daily bar on or after start_ts, with at least one day left to play."""
    bars = _bars(symbol)
    first = next((b for b in bars if b["ts"] >= start_ts), None)
    if first is None or first is bars[-1]:
        raise ledger.LedgerError(f"Pick a start before {symbol}'s last close, so there are days left to play.")
    return state(ledger.open_replay(symbol, first["ts"], cash)["id"])


def order(account_id, side, kind, shares, limit_cents=None, stop_cents=None, short=False):
    """An order placed after the clock's close. A market order fills at the next day's open."""
    acct = _replay(account_id)
    if acct["archived_at"] is not None:
        raise ledger.Conflict("This replay was closed.")
    close = _bars(acct["replay_symbol"], acct["replay_at"] - 1, acct["replay_at"])[0]["close"]
    return ledger.place_order(account_id, acct["replay_symbol"], side, kind, shares, limit_cents, stop_cents,
                              ref_price_cents=close, costs=settings.costs(), now=market.session_close(acct["replay_at"]),
                              short=short)


def step(account_id, days=1):
    """Move the clock forward, matching open orders against each new day in turn. Returns the fills."""
    acct = _replay(account_id)
    events = []
    for bar in _bars(acct["replay_symbol"], acct["replay_at"])[:days]:
        events += ledger.match(acct["replay_symbol"], [bar], settings.costs(), account_id=account_id)
        ledger.move_replay_clock(account_id, bar["ts"])
    return events


def state(account_id):
    """Everything the replay screen shows, valued at the clock's close."""
    acct = _replay(account_id)
    symbol, clock = acct["replay_symbol"], acct["replay_at"]
    seen = _bars(symbol, acct["created_at"] - 1, clock)
    closes = {b["ts"]: b["close"] for b in seen}
    last, prev = seen[-1]["close"], seen[-2]["close"] if len(seen) > 1 else seen[-1]["close"]
    days = [(b["ts"], market.session_close(b["ts"])) for b in seen]
    values = ledger.equity_curve(account_id, days, lambda s, day: closes.get(day))
    return {
        "account": acct, "symbol": symbol, "clock": clock, "days_played": len(seen) - 1,
        "days_left": len(_bars(symbol, clock)),
        "portfolio": ledger.portfolio(account_id, lambda s: last, lambda s: prev, clock),
        "orders": ledger.orders(account_id),
        "report": {
            **ledger.report_card(account_id, days, lambda s, day: closes.get(day)),
            "max_drawdown": ledger.max_drawdown(values),
            "since": acct["created_at"],
            "return": values[-1] / acct["starting_cash_cents"] - 1,
            "benchmark_return": last / seen[0]["close"] - 1,  # bought on the first day and held
            "model": model.follow_oos(symbol, acct["created_at"], clock),
        },
    }
