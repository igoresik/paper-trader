import { expect, it } from "vitest";

import { heikinAshi } from "./heikinAshi";

it("averages each bar and carries the previous midpoint", () => {
  const [first, second] = heikinAshi([
    { time: 1, open: 10, high: 14, low: 8, close: 12 },
    { time: 2, open: 12, high: 16, low: 11, close: 15 },
  ]);
  expect(first).toEqual({ time: 1, open: 11, close: 11, high: 14, low: 8 });
  expect(second.open).toBe(11); // (11 + 11) / 2
  expect(second.close).toBe(13.5); // (12 + 16 + 11 + 15) / 4
  expect([second.high, second.low]).toEqual([16, 11]);
});
