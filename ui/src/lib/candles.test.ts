import { describe, expect, it } from "vitest";

import { heikinAshi, withPrice } from "./candles";

it("heikin-ashi averages each bar and carries the previous midpoint", () => {
  const [first, second] = heikinAshi([
    { time: 1, open: 10, high: 14, low: 8, close: 12 },
    { time: 2, open: 12, high: 16, low: 11, close: 15 },
  ]);
  expect(first).toEqual({ time: 1, open: 11, close: 11, high: 14, low: 8 });
  expect(second.open).toBe(11); // (11 + 11) / 2
  expect(second.close).toBe(13.5); // (12 + 16 + 11 + 15) / 4
  expect([second.high, second.low]).toEqual([16, 11]);
});

describe("withPrice", () => {
  const candles = [{ time: 600, open: 10, high: 11, low: 9, close: 10 }];

  it("moves the minute bar the price falls in", () => {
    expect(withPrice(candles, 12, 630, 60)).toEqual([{ time: 600, open: 10, high: 12, low: 9, close: 12 }]);
  });

  it("starts the next minute bar once the minute is over", () => {
    expect(withPrice(candles, 8, 665, 60)).toEqual([...candles, { time: 660, open: 8, high: 8, low: 8, close: 8 }]);
  });

  it("only moves longer bars", () => {
    expect(withPrice(candles, 13, 99_999, 0)).toEqual([{ time: 600, open: 10, high: 13, low: 9, close: 13 }]);
  });
});
