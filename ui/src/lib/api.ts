// Typed calls to the FastAPI backend. Money is whole cents, times are unix seconds.

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type Call = "BUY" | "HOLD" | "SELL";
export type Interval = "1m" | "5m" | "1h" | "1d" | "1w";

export interface Account {
  id: number;
  name: string;
  starting_cash_cents: number;
  cash_balance_cents: number;
  created_at: number;
  archived_at: number | null;
  /** set on replays only */
  replay_symbol?: string | null;
  replay_at?: number | null;
}

export interface Position {
  symbol: string;
  shares: number;
  cost_basis_cents: number;
  avg_cost_cents: number;
  last_cents: number;
  prev_close_cents: number;
  market_value_cents: number;
  unrealized_pnl_cents: number;
  day_change_cents: number;
}

export interface Portfolio {
  account: Account;
  cash_cents: number;
  buying_power_cents: number;
  invested_cents: number;
  total_value_cents: number;
  total_return_cents: number;
  realized_pnl_cents: number;
  unrealized_pnl_cents: number;
  day_change_cents: number;
  positions: Position[];
}

export interface Trade {
  id: number;
  order_id: number;
  account_id: number;
  symbol: string;
  side: Side;
  type: OrderType;
  shares: number;
  price_cents: number;
  commission_cents: number;
  total_cents: number;
  realized_pnl_cents: number | null;
  cash_after_cents: number;
  executed_at: number;
  practice?: boolean;
}

export interface Order {
  id: number;
  account_id: number;
  symbol: string;
  side: Side;
  type: OrderType;
  shares: number;
  limit_cents: number | null;
  stop_cents: number | null;
  reserved_cents: number;
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";
  reason: string | null;
  created_at: number;
  closed_at: number | null;
  queued?: boolean;
}

export interface Quote {
  symbol: string;
  price_cents?: number;
  prev_close_cents?: number | null;
  ts?: number;
  session?: "regular" | "closed";
  ext_price_cents?: number | null;
  ext_session?: "pre" | "post";
}

export interface WatchItem {
  symbol: string;
  name: string;
  kind: string;
  price_cents: number | null;
  prev_close_cents: number | null;
  quote: Quote | null;
  signal: { signal: Call; confidence: number; ts: number; clear: boolean } | null;
}

export interface Scores {
  accuracy: number;
  balanced_accuracy: number;
}

export interface Summary {
  scores: { model: Scores; majority: Scores; always_buy: Scores; yesterday: Scores };
  edge: number;
  /** likely range for the edge; runs from before 1.1 don't have it */
  edge_range?: [number, number];
  /** runs on this symbol and bar size so far, this one included */
  tries?: number;
  verdict: string;
  fold_balanced_accuracy: { mean: number; std: number };
}

export interface Band {
  signal: Call;
  from: number;
  to: number;
  n: number;
  right: number;
}

export interface SignalReport {
  symbol: string;
  interval: "1d" | "1h";
  ts: number;
  close_cents: number;
  signal: Call;
  confidence: number;
  p_sell: number;
  p_hold: number;
  p_buy: number;
  model_id: number;
  indicators: Record<"rsi" | "ema_spread" | "vol_z" | "pct_b" | "bb_width", number>;
  model: { id: number; created_at: number; estimator: string; threshold: number; summary: Summary };
  band: Band | null;
  /** how often this outcome happened anyway, out of sample */
  base_rate: number;
  /** right clearly more often than base_rate in its confidence band */
  clear: boolean;
  live_record: { n: number; right: number };
  price_cents: number | null;
}

export interface Performance {
  total_return: number;
  cagr: number;
  sharpe: number;
  max_drawdown: number;
}

export interface Fold {
  fold: number;
  train_rows: number;
  test_rows: number;
  test_from: number;
  test_to: number;
  accuracy: number;
  balanced_accuracy: number;
  macro_f1: number;
  train_balanced_accuracy: number;
  baselines: { majority: number; always_buy: number; yesterday: number };
}

export interface RunParams {
  interval: "1d" | "1h";
  threshold: number;
  estimator: "random_forest" | "gradient_boosting";
  trees: number;
  max_depth: number;
  learning_rate: number;
  min_leaf: number;
  folds: number;
  min_confidence: number;
  cost_bps: number;
  indicators: { rsi: number; ema_fast: number; ema_slow: number; bb: number; bb_k: number; vol: number };
}

export interface Run {
  id: number;
  symbol: string;
  interval: "1d" | "1h";
  params: RunParams;
  active: boolean;
  created_at: number;
  metrics: {
    summary: Summary;
    folds?: Fold[];
    confusion?: number[][];
    backtest: {
      strategy: Performance;
      buy_hold: Performance;
      exposure: number;
      trades: number;
      hit_rate: number | null;
      curve?: { t: number[]; strategy: number[]; buy_hold: number[] };
    };
    track_record?: Band[];
    importance?: Record<string, number>;
    rows?: number;
    from?: number;
    to?: number;
  };
}

export interface ChartData {
  symbol: string;
  name: string;
  interval: Interval;
  forming: boolean;
  bars: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
  lines: Record<string, (number | null)[]>;
  calls: { ts: number; signal: Call; confidence: number; kind: "backtest" | "live" }[];
  fills: { t: number; executed_at: number; side: Side; shares: number; price_cents: number }[];
  position: { shares: number; avg_cost_cents: number } | null;
  orders: { id: number; side: Side; type: OrderType; shares: number; price_cents: number }[];
}

export interface Equity {
  t: number[];
  equity_cents: number[];
  equity_index: number[];
  benchmark: string;
  benchmark_index: (number | null)[];
}

export interface ReportBase {
  sells: number;
  wins: number;
  avg_win_cents: number | null;
  avg_loss_cents: number | null;
  commission_cents: number;
  slippage_cents: number;
  /** share of closes with shares held; null before the first close */
  time_in_market: number | null;
  /** biggest fall from a peak close, as a negative fraction; the comparisons are null before the first close */
  max_drawdown: number | null;
  /** first day of the comparison */
  since: number | null;
  return: number | null;
  /** going long on the model's buy calls over the same days */
  model: { return: number; days: number };
}

export interface ReportCard extends ReportBase {
  spy_return: number | null;
}

export interface ReplayState {
  account: Account;
  symbol: string;
  /** the latest daily bar the replay can see */
  clock: number;
  days_played: number;
  days_left: number;
  portfolio: Portfolio;
  orders: Order[];
  /** model: the active model's out-of-sample calls over the same days */
  report: ReportBase & { benchmark_return: number };
}

export interface ChartPrefs {
  type: "candles" | "hollow" | "bars" | "line" | "area" | "heikin";
  interval: Interval;
  range: string;
  scale: "linear" | "log" | "percent";
  ma1: { on: boolean; kind: "ema" | "sma"; period: number };
  ma2: { on: boolean; kind: "ema" | "sma"; period: number };
  bb: { on: boolean; period: number; width: number };
  volume: boolean;
  rsi: { on: boolean; period: number };
  macd: { on: boolean };
  calls: boolean;
  fills: boolean;
  avgCost: boolean;
  orders: boolean;
}

export interface Settings {
  commission_cents: number;
  commission_bps: number;
  slippage_bps: number;
  practice_mode: boolean;
  confirm_orders: boolean;
  theme: "system" | "dark" | "light";
  updown: "green-red" | "red-green" | "blue-orange";
  account_id: number | null;
  chart: Partial<ChartPrefs>;
  lab: Partial<RunParams> & { symbol?: string };
}

export interface Status {
  session: "pre" | "regular" | "post" | "closed";
  stream: "connecting" | "live" | "reconnecting" | "offline";
  live: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function explain(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => String(d?.msg ?? d).replace(/^Value error, /, "")).join(" ");
  return status >= 500 ? "Something went wrong in the app. Try again." : `Request failed (${status}).`;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "The app's engine isn't answering. It may still be starting.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, explain(data, response.status), data?.code);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) search.set(k, String(v));
  return `?${search}`;
};

export const api = {
  accounts: (includeArchived = false) => call<Account[]>("GET", `/accounts${q({ include_archived: includeArchived })}`),
  openAccount: (name: string, startingCashCents: number) =>
    call<Account>("POST", "/accounts", { name, starting_cash_cents: startingCashCents }),
  renameAccount: (id: number, name: string) => call<Account>("PATCH", `/accounts/${id}`, { name }),
  resetAccount: (id: number, startingCashCents?: number) =>
    call<Account>("POST", `/accounts/${id}/reset`, { starting_cash_cents: startingCashCents ?? null }),
  portfolio: (id: number) => call<Portfolio>("GET", `/portfolio/${id}`),
  history: (id: number, page: number, pageSize: number, symbol?: string, side?: Side) =>
    call<{ items: Trade[]; page: number; page_size: number; total: number }>(
      "GET",
      `/portfolio/${id}/history${q({ page, page_size: pageSize, symbol: symbol || undefined, side })}`,
    ),
  historyCsvUrl: (id: number) => `/portfolio/${id}/history.csv`,
  equity: (id: number, range: string) => call<Equity>("GET", `/portfolio/${id}/equity${q({ range })}`),
  report: (id: number) => call<ReportCard>("GET", `/portfolio/${id}/report`),
  execute: (accountId: number, symbol: string, side: Side, shares: number) =>
    call<Trade | Order>("POST", "/orders/execute", { account_id: accountId, symbol, side, shares }),
  placeOrder: (body: { account_id: number; symbol: string; side: Side; type: "LIMIT" | "STOP"; shares: number; limit_cents?: number; stop_cents?: number }) =>
    call<Order>("POST", "/orders", body),
  orders: (accountId: number, status = "OPEN") => call<Order[]>("GET", `/orders${q({ account_id: accountId, status })}`),
  cancelOrder: (id: number) => call<Order>("DELETE", `/orders/${id}`),
  search: (text: string) => call<{ symbol: string; name: string; kind: string }[]>("GET", `/market/search${q({ q: text })}`),
  signal: (symbol: string, interval: "1d" | "1h") => call<SignalReport>("GET", `/market/${symbol}/signal${q({ interval })}`),
  chart: (symbol: string, prefs: ChartPrefs, accountId: number | null, until?: number) =>
    call<ChartData>(
      "GET",
      `/market/${symbol}/chart${q({
        interval: prefs.interval,
        range: prefs.range,
        ma1: prefs.ma1.on ? `${prefs.ma1.kind}:${prefs.ma1.period}` : "",
        ma2: prefs.ma2.on ? `${prefs.ma2.kind}:${prefs.ma2.period}` : "",
        bb: prefs.bb.on ? `${prefs.bb.period}:${prefs.bb.width}` : "",
        rsi: prefs.rsi.on ? String(prefs.rsi.period) : "",
        macd: prefs.macd.on ? "12:26:9" : "",
        account_id: accountId,
        until,
      })}`,
    ),
  replays: () => call<(Account & { state: ReplayState })[]>("GET", "/replays"),
  startReplay: (symbol: string, start: number, cash: number) =>
    call<ReplayState>("POST", "/replays", { symbol, start, starting_cash_cents: cash }),
  replay: (id: number) => call<ReplayState>("GET", `/replays/${id}`),
  replayOrder: (id: number, body: { side: Side; type: OrderType; shares: number; limit_cents?: number; stop_cents?: number }) =>
    call<Order>("POST", `/replays/${id}/orders`, body),
  stepReplay: (id: number, days: number) => call<{ fills: Trade[]; state: ReplayState }>("POST", `/replays/${id}/step`, { days }),
  closeReplay: (id: number) => call<void>("DELETE", `/replays/${id}`),
  watchlist: () => call<WatchItem[]>("GET", "/watchlist"),
  watch: (symbol: string) => call<WatchItem>("POST", "/watchlist", { symbol }),
  unwatch: (symbol: string) => call<void>("DELETE", `/watchlist/${symbol}`),
  reorder: (symbols: string[]) => call<WatchItem[]>("PUT", "/watchlist", { symbols }),
  runs: (symbol: string, interval: "1d" | "1h") => call<Run[]>("GET", `/models/${symbol}/runs${q({ interval })}`),
  run: (id: number) => call<Run>("GET", `/models/runs/${id}`),
  newRun: (symbol: string, params: RunParams) => call<Run>("POST", `/models/${symbol}/runs`, params),
  activate: (id: number) => call<Run>("POST", `/models/runs/${id}/activate`),
  settings: () => call<Settings>("GET", "/settings"),
  saveSettings: (changes: Partial<Settings>) => call<Settings>("PUT", "/settings", changes),
  status: () => call<Status>("GET", "/status"),
};
