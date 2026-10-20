import { describe, expect, it } from "vitest";

import { money, parseCents, percent } from "./format";

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
