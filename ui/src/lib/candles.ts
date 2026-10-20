export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Heikin-Ashi candles: each one averages the bar and carries the previous candle's midpoint forward. */
export function heikinAshi(bars: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const bar of bars) {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const prev = out.at(-1);
    const open = prev ? (prev.open + prev.close) / 2 : (bar.open + bar.close) / 2;
    out.push({ time: bar.time, open, close, high: Math.max(bar.high, open, close), low: Math.min(bar.low, open, close) });
  }
  return out;
}

/** The candles after a live price at ts. For minute bars (size in seconds) a price past the last bar starts a new
 * one; longer bars only move, and their next bar arrives with the next fetch. */
export function withPrice(candles: Candle[], price: number, ts: number, size: number): Candle[] {
  const last = candles.at(-1);
  if (!last) return candles;
  const start = size ? ts - (ts % size) : last.time;
  if (start > last.time) return [...candles, { time: start, open: price, high: price, low: price, close: price }];
  return [...candles.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
}
