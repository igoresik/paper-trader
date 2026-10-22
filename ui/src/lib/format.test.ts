import { describe, expect, it } from "vitest";

import { edgeRange, filled, held, money, parseCents, percent } from "./format";

describe("money", () => {
  it("writes whole cents as dollars without floating point", () => {
    expect(money(123_456_789)).toBe("$1,234,567.89");
    expect(money(5)).toBe("$0.05");
    expect(money(-1_050)).toBe("−$10.50");
    expect(money(1_050, { sign: true })).toBe("+$10.50");
    expect(money(null)).toBe("—");
  });
});

describe("percent", () => {
  it("signs changes and never shows a negative zero", () => {
    expect(percent(0.0123, { sign: true })).toBe("+1.23%");
    expect(percent(-0.00001, { sign: true })).toBe("0.00%");
  });
});

describe("parseCents", () => {
  it("reads what people type", () => {
    expect(parseCents("$1,234.5")).toBe(123_450);
    expect(parseCents("10")).toBe(1_000);
    expect(parseCents("10.123")).toBeNull();
    expect(parseCents("abc")).toBeNull();
  });
});

describe("edgeRange", () => {
  it("reads as a sentence and counts the runs tried", () => {
    expect(edgeRange([-0.033, 0.054], 1)).toBe("likely between −3.3 and +5.4 points");
    expect(edgeRange([-0.04, 0.06], 3)).toBe("likely between −4.0 and +6.0 points, allowing for 3 runs on this data");
    expect(edgeRange(undefined)).toBe("");
  });
});

describe("held and filled", () => {
  it("names shorts and buy-ins", () => {
    expect(held(1_200)).toBe("1,200");
    expect(held(-10)).toBe("10 short");
    expect(filled({ side: "BUY", buy_in: true })).toBe("Bought back");
    expect(filled({ side: "SELL" })).toBe("Sold");
  });
});
