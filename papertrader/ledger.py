"""Paper ledger: portfolios, orders, fills and positions. Every change is one all-or-nothing transaction."""

import sqlite3
import time
from dataclasses import dataclass

from . import db


class LedgerError(Exception):
    """A refused action. The message is written for the user and shown as is."""

    status = 400
    code = "refused"


class InsufficientFunds(LedgerError):
    code = "insufficient_funds"


class NotEnoughShares(LedgerError):
    code = "not_enough_shares"


class NotFound(LedgerError):
    status = 404
    code = "not_found"


class Conflict(LedgerError):
    status = 409
    code = "conflict"


@dataclass(frozen=True)
class Costs:
    commission_cents: int = 0  # per order
    commission_bps: int = 0  # of the order's value; 1 bps = 0.01%
    slippage_bps: int = 0


def money(cents):
    dollars, rest = divmod(abs(cents), 100)
    return f"{'-' if cents < 0 else ''}${dollars:,}.{rest:02d}"


def avg_cost(basis_cents, shares):
    """Cost per share, rounded half up to the cent."""
    return (2 * basis_cents + shares) // (2 * shares)


def _now():
    return int(time.time())


def _ceil_div(a, b):
    return -(-a // b)


def _rows(conn, sql, params=()):
    # fetchall steps the statement to the end, so a RETURNING write is finished before COMMIT
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def fill_terms(side, shares, price_cents, costs, slip=True):
    """(price, commission, cash moved) for a fill at price_cents. Every rounding goes against the trader,
    so the ledger can never create money."""
    if slip and side == "BUY":
        price_cents = _ceil_div(price_cents * (10_000 + costs.slippage_bps), 10_000)
    elif slip:
        price_cents = max(1, price_cents * (10_000 - costs.slippage_bps) // 10_000)
    value = shares * price_cents
    fee = costs.commission_cents + _ceil_div(value * costs.commission_bps, 10_000)
    return price_cents, fee, value + fee if side == "BUY" else value - fee


# portfolios


def account(account_id):
    rows = db.query("SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not rows:
        raise NotFound(f"There is no portfolio {account_id}.")
    return rows[0]


def accounts(include_archived=False):
    where = "" if include_archived else " WHERE archived_at IS NULL"
    return db.query(f"SELECT * FROM accounts{where} ORDER BY id")


def _live_account(conn, account_id):
    rows = _rows(conn, "SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not rows:
        raise NotFound(f"There is no portfolio {account_id}.")
    if rows[0]["archived_at"] is not None:
        raise Conflict(f"{rows[0]['name']} was reset, so this old copy is read-only.")
    return rows[0]


def _clean_name(name):
    if not name.strip():
        raise LedgerError("Give the portfolio a name.")
    return name.strip()


def _open_account(conn, name, cash):
    if cash <= 0:
        raise LedgerError("Starting cash has to be more than $0.00.")
    try:
        return _rows(
            conn,
            "INSERT INTO accounts (name, starting_cash_cents, cash_balance_cents) VALUES (?, ?, ?) RETURNING *",
            (name, cash, cash),
        )[0]
    except sqlite3.IntegrityError:
        raise Conflict(f"There is already a portfolio called {name}.") from None


def create_account(name, starting_cash_cents):
    name = _clean_name(name)
    with db.tx() as conn:
        return _open_account(conn, name, starting_cash_cents)


def rename_account(account_id, name):
    name = _clean_name(name)
    with db.tx() as conn:
        _live_account(conn, account_id)
        try:
            return _rows(conn, "UPDATE accounts SET name = ? WHERE id = ? RETURNING *", (name, account_id))[0]
        except sqlite3.IntegrityError:
            raise Conflict(f"There is already a portfolio called {name}.") from None


def reset_account(account_id, starting_cash_cents=None, now=None):
    """Archive the portfolio (its history stays readable) and open a fresh one under the same name."""
    now = now or _now()
    with db.tx() as conn:
        old = _live_account(conn, account_id)
        conn.execute(
            "UPDATE orders SET status = 'CANCELLED', reason = 'The portfolio was reset.', closed_at = ?"
            " WHERE account_id = ? AND status = 'OPEN'",
            (now, account_id),
        )
        conn.execute("UPDATE accounts SET archived_at = ? WHERE id = ?", (now, account_id))
        return _open_account(conn, old["name"], starting_cash_cents or old["starting_cash_cents"])


# what is held


def _owned(conn, account_id, symbol):
    rows = _rows(
        conn, "SELECT shares, cost_basis_cents FROM positions WHERE account_id = ? AND symbol = ?", (account_id, symbol)
    )
    return (rows[0]["shares"], rows[0]["cost_basis_cents"]) if rows else (0, 0)


def _held(conn, account_id, symbol, skip_order):
    """Cash held by open buys and shares of symbol held by open sells, leaving out skip_order."""
    row = _rows(
        conn,
        "SELECT COALESCE(SUM(CASE WHEN side = 'BUY' THEN reserved_cents END), 0) AS cash,"
        " COALESCE(SUM(CASE WHEN side = 'SELL' AND symbol = ? THEN shares END), 0) AS shares"
        " FROM orders WHERE account_id = ? AND status = 'OPEN' AND id IS NOT ?",
        (symbol, account_id, skip_order),
    )[0]
    return row["cash"], row["shares"]


def _check_cash(conn, acct, symbol, needed, skip_order=None):
    held, _ = _held(conn, acct["id"], symbol, skip_order)
    free = acct["cash_balance_cents"] - held
    if needed > free:
        note = f" {money(held)} is held for open orders." if held else ""
        raise InsufficientFunds(f"Not enough cash: this order needs {money(needed)} and you have {money(free)}.{note}")


def _check_shares(conn, account_id, symbol, wanted, skip_order=None):
    owned, _ = _owned(conn, account_id, symbol)
    _, held = _held(conn, account_id, symbol, skip_order)
    if wanted > owned - held:
        if not owned:
            raise NotEnoughShares(f"You don't own any {symbol}.")
        note = f" {held} are already in open orders." if held else ""
        raise NotEnoughShares(f"You own {owned} {symbol}, so you can sell up to {owned - held}.{note}")


# orders


def _new_order(conn, account_id, symbol, side, kind, shares, limit_cents, stop_cents, reserved, now):
    if shares < 1:
        raise LedgerError("Enter at least 1 share.")
    return _rows(
        conn,
        "INSERT INTO orders (account_id, symbol, side, type, shares, limit_cents, stop_cents, reserved_cents, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        (account_id, symbol, side, kind, shares, limit_cents, stop_cents, reserved, now),
    )[0]


def _fill(conn, order, price_cents, now, costs, slip):
    """Book one fill inside the caller's transaction. Claiming the order first means it can only fill once."""
    claimed = conn.execute(
        "UPDATE orders SET status = 'FILLED', closed_at = ? WHERE id = ? AND status = 'OPEN'", (now, order["id"])
    ).rowcount
    if not claimed:
        raise Conflict("This order is no longer open.")
    acct = _live_account(conn, order["account_id"])
    side, symbol, shares = order["side"], order["symbol"], order["shares"]
    price, fee, total = fill_terms(side, shares, price_cents, costs, slip)
    realized = None
    if side == "BUY":
        _check_cash(conn, acct, symbol, total, order["id"])
        conn.execute(
            "INSERT INTO positions (account_id, symbol, shares, cost_basis_cents) VALUES (?, ?, ?, ?)"
            " ON CONFLICT (account_id, symbol) DO UPDATE SET shares = shares + excluded.shares,"
            " cost_basis_cents = cost_basis_cents + excluded.cost_basis_cents",
            (acct["id"], symbol, shares, total),
        )
        cash_change = -total
    else:
        _check_shares(conn, acct["id"], symbol, shares, order["id"])
        owned, basis = _owned(conn, acct["id"], symbol)
        removed = basis if shares == owned else basis * shares // owned
        realized = total - removed
        if shares == owned:
            conn.execute("DELETE FROM positions WHERE account_id = ? AND symbol = ?", (acct["id"], symbol))
        else:
            conn.execute(
                "UPDATE positions SET shares = shares - ?, cost_basis_cents = cost_basis_cents - ?"
                " WHERE account_id = ? AND symbol = ?",
                (shares, removed, acct["id"], symbol),
            )
        if acct["cash_balance_cents"] + total < 0:
            raise InsufficientFunds(f"Not enough cash to pay this sale's {money(fee)} commission.")
        cash_change = total
    cash_after = _rows(
        conn,
        "UPDATE accounts SET cash_balance_cents = cash_balance_cents + ? WHERE id = ? RETURNING cash_balance_cents",
        (cash_change, acct["id"]),
    )[0]["cash_balance_cents"]
    trade = _rows(
        conn,
        "INSERT INTO trades (order_id, account_id, symbol, side, shares, price_cents, commission_cents, total_cents,"
        " realized_pnl_cents, cash_after_cents, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        (order["id"], acct["id"], symbol, side, shares, price, fee, total, realized, cash_after, now),
    )[0]
    return {**trade, "type": order["type"]}


def execute_market(account_id, symbol, side, shares, price_cents, costs=Costs(), now=None):
    """Fill a market order now at price_cents. A refused order leaves no trace."""
    now = now or _now()
    with db.tx() as conn:
        _live_account(conn, account_id)
        order = _new_order(conn, account_id, symbol, side, "MARKET", shares, None, None, 0, now)
        return _fill(conn, order, price_cents, now, costs, slip=True)


def place_order(
    account_id, symbol, side, kind, shares, limit_cents=None, stop_cents=None, ref_price_cents=None,
    costs=Costs(), now=None,
):
    """Open an order that waits for its price: a limit, a stop, or a market order queued while the market is closed."""
    now = now or _now()
    if kind == "LIMIT" and not (limit_cents and stop_cents is None):
        raise LedgerError("A limit order needs a limit price.")
    if kind == "STOP" and not (stop_cents and limit_cents is None):
        raise LedgerError("A stop order needs a stop price.")
    if kind == "MARKET" and (limit_cents or stop_cents or not ref_price_cents):
        raise LedgerError("A queued market order needs the current price and no limit or stop.")
    if kind == "STOP" and ref_price_cents:
        if side == "BUY" and stop_cents <= ref_price_cents:
            raise LedgerError(f"A buy stop has to be above the current price ({money(ref_price_cents)}).")
        if side == "SELL" and stop_cents >= ref_price_cents:
            raise LedgerError(f"A sell stop has to be below the current price ({money(ref_price_cents)}).")
    with db.tx() as conn:
        acct = _live_account(conn, account_id)
        reserved = 0
        if side == "BUY":
            estimate = {"LIMIT": limit_cents, "STOP": stop_cents, "MARKET": ref_price_cents}[kind]
            reserved = fill_terms("BUY", shares, estimate, costs, slip=kind != "LIMIT")[2]
            _check_cash(conn, acct, symbol, reserved)
        else:
            _check_shares(conn, account_id, symbol, shares)
        return _new_order(conn, account_id, symbol, side, kind, shares, limit_cents, stop_cents, reserved, now)


def cancel_order(order_id, now=None):
    with db.tx() as conn:
        rows = _rows(
            conn,
            "UPDATE orders SET status = 'CANCELLED', closed_at = ? WHERE id = ? AND status = 'OPEN' RETURNING *",
            (now or _now(), order_id),
        )
        if rows:
            return rows[0]
        found = _rows(conn, "SELECT status FROM orders WHERE id = ?", (order_id,))
    if not found:
        raise NotFound(f"There is no order {order_id}.")
    raise Conflict(f"This order is already {found[0]['status'].lower()}.")


def trigger_price(order, bar):
    """Price an open order fills at on this bar, or None. A live tick is a bar with one price."""
    side, kind = order["side"], order["type"]
    if kind == "MARKET":
        return bar["open"]
    if kind == "LIMIT":
        limit = order["limit_cents"]
        if side == "BUY" and bar["low"] <= limit:
            return min(limit, bar["open"])
        if side == "SELL" and bar["high"] >= limit:
            return max(limit, bar["open"])
        return None
    stop = order["stop_cents"]
    if side == "BUY" and bar["high"] >= stop:
        return max(stop, bar["open"])
    if side == "SELL" and bar["low"] <= stop:
        return min(stop, bar["open"])
    return None


def _reject(order, reason, now):
    with db.tx() as conn:
        rejected = conn.execute(
            "UPDATE orders SET status = 'REJECTED', reason = ?, closed_at = ? WHERE id = ? AND status = 'OPEN'",
            (reason, now, order["id"]),
        ).rowcount
    if rejected:
        return {"order_id": order["id"], "account_id": order["account_id"], "symbol": order["symbol"],
                "status": "REJECTED", "reason": reason}
    return None


def match(symbol, bars, costs=Costs()):
    """Fill the symbol's open orders against bars (oldest first), booking fills in the order they happened."""
    hits = []
    for order in db.query("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN'", (symbol,)):
        for bar in bars:
            # a bar that began before the order existed may have traded before it, so it doesn't count
            if bar["ts"] >= order["created_at"] and (price := trigger_price(order, bar)) is not None:
                hits.append((bar["ts"], order["id"], order, price))
                break
    events = []
    for ts, _, order, price in sorted(hits, key=lambda hit: hit[:2]):
        try:
            with db.tx() as conn:
                events.append(_fill(conn, order, price, ts, costs, slip=order["type"] != "LIMIT"))
        except Conflict:
            continue  # cancelled, or filled by another run meanwhile
        except LedgerError as refused:
            if event := _reject(order, str(refused), ts):
                events.append(event)
    return events


# reading


def positions(account_id):
    return db.query(
        "SELECT symbol, shares, cost_basis_cents FROM positions WHERE account_id = ? ORDER BY symbol", (account_id,)
    )


def orders(account_id, status="OPEN"):
    return db.query(
        "SELECT * FROM orders WHERE account_id = ? AND status = ? ORDER BY created_at DESC, id DESC",
        (account_id, status),
    )


def history(account_id, page=1, page_size=50, symbol=None, side=None):
    where, params = "t.account_id = ?", [account_id]
    if symbol:
        where, params = where + " AND t.symbol = ?", [*params, symbol]
    if side:
        where, params = where + " AND t.side = ?", [*params, side]
    total = db.query(f"SELECT COUNT(*) AS n FROM trades t WHERE {where}", params)[0]["n"]
    items = db.query(
        f"SELECT t.*, o.type FROM trades t JOIN orders o ON o.id = t.order_id WHERE {where}"
        " ORDER BY t.executed_at DESC, t.id DESC LIMIT ? OFFSET ?",
        [*params, page_size, (page - 1) * page_size],
    )
    return {"items": items, "page": page, "page_size": page_size, "total": total}


def portfolio(account_id, price, prev_close, day_start):
    """Value the portfolio. price(symbol) and prev_close(symbol) give cents or None. Today's change runs from
    the previous close for shares held overnight and from the fill price for shares traded since day_start."""
    acct = account(account_id)
    held = {p["symbol"]: p for p in positions(account_id)}
    today = db.query(
        "SELECT symbol, side, shares, total_cents FROM trades WHERE account_id = ? AND executed_at >= ?",
        (account_id, day_start),
    )
    totals = db.query(
        "SELECT (SELECT COALESCE(SUM(realized_pnl_cents), 0) FROM trades WHERE account_id = :a) AS realized,"
        " (SELECT COALESCE(SUM(reserved_cents), 0) FROM orders"
        "  WHERE account_id = :a AND status = 'OPEN' AND side = 'BUY') AS reserved",
        {"a": account_id},
    )[0]
    rows, day_change, sign = [], 0, {"BUY": 1, "SELL": -1}
    for symbol in sorted(held.keys() | {t["symbol"] for t in today}):
        pos = held.get(symbol, {"shares": 0, "cost_basis_cents": 0})
        shares, basis = pos["shares"], pos["cost_basis_cents"]
        last = price(symbol) or prev_close(symbol) or (basis // shares if shares else 0)
        prev = prev_close(symbol) or last
        bought = sum(sign[t["side"]] * t["shares"] for t in today if t["symbol"] == symbol)
        spent = sum(sign[t["side"]] * t["total_cents"] for t in today if t["symbol"] == symbol)
        change = shares * last - (shares - bought) * prev - spent
        day_change += change
        if shares:
            rows.append({
                "symbol": symbol, "shares": shares, "cost_basis_cents": basis,
                "avg_cost_cents": avg_cost(basis, shares), "last_cents": last,
                "prev_close_cents": prev, "market_value_cents": shares * last,
                "unrealized_pnl_cents": shares * last - basis, "day_change_cents": change,
            })
    invested = sum(r["market_value_cents"] for r in rows)
    cash = acct["cash_balance_cents"]
    return {
        "account": acct,
        "cash_cents": cash,
        "buying_power_cents": cash - totals["reserved"],
        "invested_cents": invested,
        "total_value_cents": cash + invested,
        "total_return_cents": cash + invested - acct["starting_cash_cents"],
        "realized_pnl_cents": totals["realized"],
        "unrealized_pnl_cents": sum(r["unrealized_pnl_cents"] for r in rows),
        "day_change_cents": day_change,
        "positions": rows,
    }


def equity_curve(account_id, days, close_on):
    """Portfolio value at each day's close: cash then, plus the shares held then at that day's closing price.
    days are (daily bar start, moment of that day's close); close_on(symbol, day) gives cents."""
    acct = account(account_id)
    # cash_after_cents follows booking order, and a catch-up fill can be booked after a later one, so add up totals
    trades = db.query(
        "SELECT symbol, side, shares, total_cents, executed_at FROM trades WHERE account_id = ?"
        " ORDER BY executed_at, id",
        (account_id,),
    )
    values, held, cash, done = [], {}, acct["starting_cash_cents"], 0
    for day, closed_at in days:
        while done < len(trades) and trades[done]["executed_at"] <= closed_at:
            t = trades[done]
            buy = t["side"] == "BUY"
            held[t["symbol"]] = held.get(t["symbol"], 0) + (t["shares"] if buy else -t["shares"])
            cash, done = cash + (-t["total_cents"] if buy else t["total_cents"]), done + 1
        values.append(cash + sum(n * (close_on(symbol, day) or 0) for symbol, n in held.items() if n))
    return values
