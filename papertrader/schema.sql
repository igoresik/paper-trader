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

-- market data

CREATE TABLE symbols (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    exchange TEXT,
    kind TEXT NOT NULL, -- EQUITY or ETF
    currency TEXT NOT NULL
);

-- complete bars only; prices are split-adjusted, as brokers chart them
CREATE TABLE bars (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL CHECK (interval IN ('1h', '1d')),
    ts INTEGER NOT NULL, -- bar start
    open_cents INTEGER NOT NULL,
    high_cents INTEGER NOT NULL,
    low_cents INTEGER NOT NULL,
    close_cents INTEGER NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;

CREATE TABLE fetches (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, interval)
) WITHOUT ROWID;

-- feature store: indicators per bar, built with the active model's settings
CREATE TABLE features (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rsi REAL,
    ema_spread REAL,
    vol_z REAL,
    pct_b REAL,
    bb_width REAL,
    PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;

-- signal model: each validation run, its out-of-sample predictions, and the signals shown live

CREATE TABLE models (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    params TEXT NOT NULL, -- JSON
    metrics TEXT NOT NULL, -- JSON: folds, baselines, backtest, track record
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX one_active_model ON models (symbol, interval) WHERE active = 1;

CREATE TABLE predictions (
    model_id INTEGER NOT NULL REFERENCES models (id),
    ts INTEGER NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'HOLD', 'SELL')),
    confidence REAL NOT NULL,
    actual TEXT NOT NULL CHECK (actual IN ('BUY', 'HOLD', 'SELL')),
    PRIMARY KEY (model_id, ts)
) WITHOUT ROWID;

-- the first signal shown for each bar is kept, so the live record can't be rewritten by retraining
CREATE TABLE signals (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    ts INTEGER NOT NULL, -- the bar the signal was made after
    close_cents INTEGER NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('BUY', 'HOLD', 'SELL')),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    p_buy REAL NOT NULL,
    p_hold REAL NOT NULL,
    p_sell REAL NOT NULL,
    model_id INTEGER NOT NULL REFERENCES models (id),
    PRIMARY KEY (symbol, interval, ts)
) WITHOUT ROWID;

-- app state

CREATE TABLE watchlist (
    symbol TEXT PRIMARY KEY REFERENCES symbols (symbol),
    position INTEGER NOT NULL
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON
);

PRAGMA user_version = 1;
