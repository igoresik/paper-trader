// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CHART } from "../desk";
import { api, type Account, type ReplayState } from "../lib/api";
import { Replay } from "./Replay";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../components/PriceChart", () => ({ PriceChart: () => null }));
vi.mock("../desk", async (real) => ({
  ...(await real<typeof import("../desk")>()),
  useDesk: () => ({ chart: DEFAULT_CHART, theme: "light", settings: { updown: "green-red" } }),
}));

const account = { id: 5, name: "SPY replay" } as Account;
const state = {
  account, symbol: "SPY", clock: 1_700_000_000, days_played: 3, days_left: 100,
  portfolio: { total_value_cents: 1_000_000, cash_cents: 1_000_000, positions: [] },
  orders: [{ id: 9, side: "BUY", type: "LIMIT", shares: 2, limit_cents: 40_000, stop_cents: null }],
  report: {
    sells: 0, wins: 0, avg_win_cents: null, avg_loss_cents: null, commission_cents: 0, slippage_cents: 0,
    time_in_market: null, max_drawdown: null, since: 1_700_000_000, return: null, model: { return: 0, days: 0 }, benchmark_return: 0,
  },
} as unknown as ReplayState;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Replay", () => {
  it("says why an order couldn't be cancelled", async () => {
    vi.spyOn(api, "replays").mockResolvedValue([{ ...account, state }]);
    vi.spyOn(api, "replay").mockResolvedValue(state);
    vi.spyOn(api, "chart").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "cancelOrder").mockRejectedValue(new Error("This order is already filled."));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Replay />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Cancel order 9" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This order is already filled."));
  });

  it("says why a replay couldn't be closed", async () => {
    vi.spyOn(api, "replays").mockResolvedValue([{ ...account, state }]);
    vi.spyOn(api, "replay").mockResolvedValue(state);
    vi.spyOn(api, "chart").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "closeReplay").mockRejectedValue(new Error("There is no replay 5."));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Replay />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Close replay" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("There is no replay 5."));
  });
});
