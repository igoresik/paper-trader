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
