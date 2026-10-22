// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ReportBase } from "../lib/api";
import { ReportTiles } from "./ReportTiles";

const model = { label: "SPY's model", note: (days: number) => `its buy calls over ${days} days`, none: "Needs a close first" };

const fresh: ReportBase = {
  sells: 0, wins: 0, avg_win_cents: null, avg_loss_cents: null, commission_cents: 0, slippage_cents: 0,
  time_in_market: null, max_drawdown: null, since: null, return: null, model: { return: 0, days: 0 },
};

const tile = (label: string) => screen.getByText(label).parentElement!;

afterEach(cleanup);

describe("ReportTiles", () => {
  it("shows dashes, not zeros, before there is anything to measure", () => {
    render(<ReportTiles r={fresh} model={model} />);
    expect(tile("Sales that made money").textContent).toBe("Sales that made money–Shows up after your first sale");
    expect(tile("Biggest drop").textContent).toContain("–");
    expect(tile("SPY's model").textContent).toBe("SPY's model–Needs a close first");
  });

  it("signs wins and losses with arrows as well as colour", () => {
    render(<ReportTiles r={{ ...fresh, sells: 4, wins: 3, avg_win_cents: 1_250, avg_loss_cents: -3_000, max_drawdown: -0.084,
      commission_cents: 400, slippage_cents: 37, time_in_market: 0.5, model: { return: 0.031, days: 20 } }} model={model} />);
    expect(tile("Sales that made money").textContent).toContain("75%3 of 4 sales");
    expect(tile("Average win and loss").textContent).toContain("▲ +$12.50 / ▼ −$30.00");
    expect(tile("Biggest drop").textContent).toContain("▼ −8.4%");
    expect(tile("Costs paid").textContent).toBe("Costs paid$4.37$4.00 commission, $0.37 slippage");
    expect(tile("SPY's model").textContent).toBe("SPY's model▲ +3.1%its buy calls over 20 days");
  });
});
