// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, type Portfolio, type Settings, type Trade } from "../lib/api";
import { Ticket } from "./Ticket";

const desk = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../desk", () => ({ useDesk: () => desk.current }));
vi.mock("../lib/live", () => ({
  useQuote: () => ({ symbol: "AAPL", session: "regular", price_cents: 10_003 }), // $100.03, so every rounding shows
  useStatus: () => ({ live: true }),
  markShown: vi.fn(),
}));

const fill = { id: 7, order_id: 3, side: "BUY", type: "MARKET", symbol: "AAPL", shares: 10, price_cents: 10_014,
  commission_cents: 151, total_cents: 100_291, realized_pnl_cents: null, cash_after_cents: 899_709, executed_at: 1_792_416_600 } as Trade;
const settings = { commission_cents: 100, commission_bps: 5, slippage_bps: 10, confirm_orders: false, practice_mode: false } as Settings;

function portfolio(buyingPower = 1_000_000, owned = 0): Portfolio {
  const positions = owned ? [{ symbol: "AAPL", shares: owned }] : [];
  return { buying_power_cents: buyingPower, positions } as Portfolio;
}

function show(p = portfolio(), extra: Partial<Settings> = {}) {
  desk.current = { symbol: "AAPL", accountId: 1, settings: { ...settings, ...extra }, preset: null };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Ticket portfolio={p} lastPrice={null} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const ticket = () => within(screen.getByRole("form", { name: "Order ticket" }));
const submit = () => ticket().getAllByRole("button").find((b) => b.getAttribute("type") === "submit")!;
const shown = (term: string) => ticket().getByText(term).nextElementSibling?.textContent;

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup);

describe("Ticket", () => {
  it("estimates like the ledger: slippage and commission round against the trader", () => {
    show();
    expect(shown("Price with slippage")).toBe("$100.14"); // $100.03 + 10 bps, rounded up
    expect(shown("Commission")).toBe("$1.51"); // $1.00 + 5 bps of $1,001.40, rounded up
    expect(shown("Estimated cost")).toBe("$1,002.91");
    expect(submit().textContent).toBe("Buy 10 AAPL");
  });

  it("sends a market order and prints the receipt", async () => {
    const execute = vi.spyOn(api, "execute").mockResolvedValue(fill);
    const user = show();
    await user.click(submit());
    expect(execute).toHaveBeenCalledWith(1, "AAPL", "BUY", 10);
    const receipt = await screen.findByRole("status");
    expect(within(receipt).getByText("Total paid").nextElementSibling?.textContent).toBe("$1,002.91");
  });

  it("won't sell shares that aren't owned", async () => {
    const user = show(portfolio(1_000_000, 5));
    await user.click(ticket().getByRole("tab", { name: "Sell" }));
    expect(ticket().getByText("You own 5 AAPL.")).toBeTruthy();
    await user.clear(ticket().getByLabelText("Shares"));
    await user.type(ticket().getByLabelText("Shares"), "6");
    expect(ticket().getByText("You own 5 AAPL.")).toBeTruthy();
    expect(submit().hasAttribute("disabled")).toBe(true);
    await user.clear(ticket().getByLabelText("Shares"));
    await user.type(ticket().getByLabelText("Shares"), "5");
    expect(submit().hasAttribute("disabled")).toBe(false);
    expect(shown("Estimated proceeds")).toBe("$498.35"); // 5 x $99.92 (slippage rounded down) - $1.25
  });

  it("won't spend a cent more than the buying power", () => {
    show(portfolio(100_290));
    expect(ticket().getByText("That needs $1,002.91; you have $1,002.90 to spend.")).toBeTruthy();
    expect(submit().hasAttribute("disabled")).toBe(true);
    cleanup();
    show(portfolio(100_291));
    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("Max buys as many whole shares as the buying power covers after costs", async () => {
    const user = show(portfolio(100_000));
    await user.click(ticket().getByRole("button", { name: "Max" }));
    expect((ticket().getByLabelText("Shares") as HTMLInputElement).value).toBe("9"); // 10 would need $1,002.91
    expect(shown("Estimated cost")).toBe("$902.72");
  });

  it("turns a dollar amount into whole shares", async () => {
    const user = show();
    await user.click(ticket().getByRole("button", { name: "Shares" }));
    await user.clear(ticket().getByLabelText("Amount in dollars"));
    await user.type(ticket().getByLabelText("Amount in dollars"), "1000");
    expect(ticket().getByText("= 9 whole shares")).toBeTruthy(); // 9.997 rounds down
  });

  it("sends a limit order at its price, without slippage", async () => {
    const place = vi.spyOn(api, "placeOrder").mockResolvedValue({ id: 4, side: "BUY", type: "LIMIT", symbol: "AAPL", shares: 10,
      limit_cents: 9_950, stop_cents: null, reserved_cents: 99_600, status: "OPEN", created_at: 1_792_416_600 } as never);
    const user = show();
    await user.click(ticket().getByRole("radio", { name: "Limit" }));
    await user.clear(ticket().getByLabelText("Limit price"));
    await user.type(ticket().getByLabelText("Limit price"), "99.50");
    expect(shown("Price")).toBe("$99.50");
    await user.click(submit());
    expect(place).toHaveBeenCalledWith({ account_id: 1, symbol: "AAPL", side: "BUY", type: "LIMIT", shares: 10, limit_cents: 9_950 });
  });

  it("asks again when the order changes after the first click", async () => {
    const execute = vi.spyOn(api, "execute").mockResolvedValue(fill);
    const user = show(portfolio(10_000_000), { confirm_orders: true });
    await user.click(submit());
    expect(submit().textContent).toBe("Confirm: Buy 10 AAPL");
    await user.type(ticket().getByLabelText("Shares"), "0");
    expect(submit().textContent).toBe("Buy 100 AAPL");
    expect(execute).not.toHaveBeenCalled();
    await user.click(submit());
    await user.click(submit());
    expect(execute).toHaveBeenCalledWith(1, "AAPL", "BUY", 100);
  });

  it("shows why the engine refused an order", async () => {
    vi.spyOn(api, "execute").mockRejectedValue(new ApiError(400, "Not enough cash: this order needs $1,002.00 and you have $900.00."));
    const user = show();
    await user.click(submit());
    await waitFor(() => expect(ticket().getByText(/^Not enough cash/)).toBeTruthy());
  });
});
