// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CHART } from "../desk";
import { api, type SignalReport } from "../lib/api";
import { SignalCard } from "./SignalCard";

vi.mock("../desk", async (real) => ({
  ...(await real<typeof import("../desk")>()),
  useDesk: () => ({ symbol: "SPY", chart: DEFAULT_CHART, setView: vi.fn() }),
}));

const scores = (balanced_accuracy: number) => ({ accuracy: balanced_accuracy, balanced_accuracy });

function report(changes: Partial<SignalReport> = {}): SignalReport {
  return {
    symbol: "SPY", interval: "1d", ts: 1_792_440_000, close_cents: 70_000, signal: "BUY", confidence: 0.41,
    p_sell: 0.25, p_hold: 0.34, p_buy: 0.41, model_id: 1,
    indicators: { rsi: 55, ema_spread: 0.004, vol_z: 0.3, pct_b: 0.62, bb_width: 0.05 },
    model: {
      id: 1, created_at: 0, estimator: "rf", threshold: 0.005, horizon: 1,
      summary: {
        scores: { model: scores(0.448), majority: scores(0.333), always_buy: scores(0.333), yesterday: scores(0.354) },
        edge: 0.094, edge_range: [0.077, 0.11], tries: 1, verdict: "better than the simple rules",
        fold_balanced_accuracy: { mean: 0.44, std: 0.02 }, direction: { n: 3_000, right: 1_560, range: [0.501, 0.54] },
      },
    },
    band: null, base_rate: 0.4,
    moved: { n: 104, right: 64, base_rate: 0.544 },
    clear: false,
    live_record: { n: 0, right: 0 },
    price_cents: 70_000,
    ...changes,
  };
}

async function show(r: SignalReport) {
  vi.spyOn(api, "signal").mockResolvedValue(r);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Tooltip.Provider>
        <SignalCard />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  await screen.findByText("Educational, not financial advice.");
}

afterEach(cleanup);

describe("SignalCard", () => {
  it("says No clear edge, with the lean, when the call hasn't beaten the drift", async () => {
    await show(report());
    expect(screen.getByText("No clear edge")).toBeTruthy();
    expect(screen.queryByText("Buy")).toBeNull();
    expect(screen.getByText(/had the direction right on 64 \(62%\)\. Up came 54% of the time anyway\./)).toBeTruthy();
  });

  it("shows a clear call in big letters", async () => {
    await show(report({ clear: true, signal: "SELL", p_sell: 0.5, p_buy: 0.16, confidence: 0.5, moved: { n: 80, right: 50, base_rate: 0.46 } }));
    expect(screen.getByText("Sell")).toBeTruthy();
    expect(screen.queryByText("No clear edge")).toBeNull();
    expect(screen.getByText(/A coin toss is 50%\./)).toBeTruthy();
  });

  it("compares the model with the best simple rule and gives the likely range", async () => {
    await show(report());
    expect(screen.getByText(/balanced accuracy 44\.8% against 35\.4% for the best simple rule \(an edge likely between \+7\.7 and \+11\.0 points\)\./)).toBeTruthy();
    expect(screen.getByText(/Up or down alone, on days that moved, it was right 52% of the time\./)).toBeTruthy();
  });

  it("counts the live record only once there is one", async () => {
    await show(report());
    expect(screen.getByText(/starts once the next bar closes\./)).toBeTruthy();
    cleanup();
    await show(report({ live_record: { n: 12, right: 7 } }));
    expect(screen.getByText("7 of 12 right")).toBeTruthy();
  });

  it("shows the move reading with its record against chance", async () => {
    const move = { call: "BIG", p_big: 0.66, confidence: 0.66, usual: 0.006, band: { signal: "BIG", from: 0.6, to: 0.7, n: 900, right: 560 },
      base_rate: 0.5, clear: true, summary: report().model.summary, live_record: { n: 0, right: 0 } } as const;
    await show(report({ move }));
    expect(screen.getByText("Bigger move than usual")).toBeTruthy();
    expect(screen.getByText(/it was right 560 of 900 times \(62%\), against 50% by chance\./)).toBeTruthy();
  });
});
