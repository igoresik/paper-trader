-- Money is whole cents and quantities are whole shares, so no amount goes through floating point.
-- Times are unix seconds (UTC).

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    starting_cash_cents INTEGER NOT NULL CHECK (starting_cash_cents > 0),
    cash_balance_cents INTEGER NOT NULL CHECK (cash_balance_cents >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    archived_at INTEGER
);
-- a reset archives the account and opens a new one under the same name
CREATE UNIQUE INDEX account_name ON accounts (name) WHERE archived_at IS NULL;

CREATE TABLE positions (
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    symbol TEXT NOT NULL,
    shares INTEGER NOT NULL CHECK (shares > 0),
    cost_basis_cents INTEGER NOT NULL CHECK (cost_basis_cents >= 0),
    PRIMARY KEY (account_id, symbol)
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    type TEXT NOT NULL CHECK (type IN ('MARKET', 'LIMIT', 'STOP')),
    shares INTEGER NOT NULL CHECK (shares > 0),
    limit_cents INTEGER CHECK (limit_cents > 0),
    stop_cents INTEGER CHECK (stop_cents > 0),
    -- cash an open buy may need, so it can't be spent twice
    reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED', 'REJECTED')),
    reason TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    CHECK ((type = 'LIMIT') = (limit_cents IS NOT NULL)),
    CHECK ((type = 'STOP') = (stop_cents IS NOT NULL))
);
CREATE INDEX open_orders ON orders (symbol) WHERE status = 'OPEN';

-- the audit log: one row per fill, never changed afterwards
CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders (id),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    shares INTEGER NOT NULL CHECK (shares > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
    total_cents INTEGER NOT NULL, -- cash paid for a buy, cash received for a sell
    realized_pnl_cents INTEGER, -- sells only
    cash_after_cents INTEGER NOT NULL CHECK (cash_after_cents >= 0),
    executed_at INTEGER NOT NULL
);
CREATE INDEX trades_by_account ON trades (account_id, executed_at);
CREATE TRIGGER trades_no_update BEFORE UPDATE ON trades
BEGIN SELECT RAISE(ABORT, 'trades are append-only'); END;
CREATE TRIGGER trades_no_delete BEFORE DELETE ON trades
BEGIN SELECT RAISE(ABORT, 'trades are append-only'); END;

PRAGMA user_version = 1;
