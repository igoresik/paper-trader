// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type Discover as DiscoverData, type DiscoverItem, type WatchItem } from "../lib/api";
import { Discover, sorted } from "./Discover";

const desk = vi.hoisted(() => ({ setSymbol: vi.fn(), setView: vi.fn() }));
vi.mock("../desk", () => ({ useDesk: () => desk }));

const item = (symbol: string, name: string, categories: string[], day: number, month: number | null = 0.05, kind: "EQUITY" | "ETF" = "EQUITY"): DiscoverItem => ({
  symbol, name, kind, categories, price_cents: 10_000, day, month, year: month, spark: [1, 2, 3],
});
const items = [
  item("AAPL", "Apple", ["tech"], 0.01),
  item("JPM", "JPMorgan Chase", ["finance"], -0.03),
  item("NVDA", "NVIDIA", ["tech", "ai"], 0.04, null),
  item("SPY", "SPDR S&P 500 ETF", ["etf"], 0.002, 0.02, "ETF"),
];
const data: DiscoverData = {
  updated: 1_792_416_600,
  categories: [
    { id: "tech", label: "Big tech", blurb: "The largest technology companies", count: 2 },
    { id: "finance", label: "Banks and finance", blurb: "Banks and card networks", count: 1 },
    { id: "etf", label: "ETFs", blurb: "Funds", count: 1 },
  ],
  items,
};

function show(watching: WatchItem[] = []) {
  vi.spyOn(api, "discover").mockResolvedValue(data);
  vi.spyOn(api, "watchlist").mockResolvedValue(watching);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Discover />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => (cleanup(), vi.restoreAllMocks()));

describe("sorted", () => {
  it("keeps the list order for popular", () => {
    expect(sorted(items, "popular").map((i) => i.symbol)).toEqual(["AAPL", "JPM", "NVDA", "SPY"]);
  });
  it("puts the biggest risers first and the biggest fallers first", () => {
    expect(sorted(items, "gainers").map((i) => i.symbol)).toEqual(["NVDA", "AAPL", "SPY", "JPM"]);
    expect(sorted(items, "losers").map((i) => i.symbol)).toEqual(["JPM", "SPY", "AAPL", "NVDA"]);
  });
  it("leaves a symbol with no month figure last", () => {
    expect(sorted(items, "month").map((i) => i.symbol).at(-1)).toBe("NVDA");
  });
});

describe("Discover", () => {
  it("shows every symbol, and a category narrows it", async () => {
    show();
    expect(await screen.findByText("Apple")).toBeTruthy();
    expect(screen.getByText("SPDR S&P 500 ETF")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Banks and finance/ }));
    expect(screen.getByText("JPMorgan Chase")).toBeTruthy();
    expect(screen.queryByText("Apple")).toBeNull();
    expect(screen.getByRole("heading", { name: "Banks and finance" })).toBeTruthy();
  });

  it("filters by name or ticker and says so when nothing matches", async () => {
    show();
    await screen.findByText("Apple");
    await userEvent.type(screen.getByLabelText("Filter by name or ticker"), "nvid");
    expect(screen.getByText("NVIDIA")).toBeTruthy();
    expect(screen.queryByText("Apple")).toBeNull();
    await userEvent.type(screen.getByLabelText("Filter by name or ticker"), "zzz");
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });

  it("shows only ETFs when asked", async () => {
    show();
    await screen.findByText("Apple");
    await userEvent.click(screen.getByRole("radio", { name: "ETFs" }));
    expect(screen.getByText("SPDR S&P 500 ETF")).toBeTruthy();
    expect(screen.queryByText("Apple")).toBeNull();
  });

  it("marks what you already watch and shows the model's clear call", async () => {
    show([{ symbol: "AAPL", name: "Apple", kind: "EQUITY", price_cents: 1, prev_close_cents: 1, quote: null,
      signal: { signal: "BUY", confidence: 0.6, ts: 1, clear: true } }]);
    await screen.findByText("Apple");
    expect(screen.getByRole("button", { name: "AAPL is on your watchlist" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add JPM to your watchlist" })).toBeTruthy();
    expect(screen.getByText("BUY")).toBeTruthy();
  });

  it("adds to the watchlist, and Open chart adds first and then goes to the trade view", async () => {
    const watch = vi.spyOn(api, "watch").mockImplementation(async (symbol) => ({ symbol, name: symbol, kind: "EQUITY", price_cents: 1, prev_close_cents: 1, quote: null, signal: null }));
    show();
    const card = (await screen.findByText("JPMorgan Chase")).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "Open chart" }));
    await waitFor(() => expect(desk.setView).toHaveBeenCalledWith("trade"));
    expect(watch).toHaveBeenCalledWith("JPM", expect.anything());
    expect(desk.setSymbol).toHaveBeenCalledWith("JPM");
  });

  it("explains a failure and offers another try", async () => {
    vi.spyOn(api, "discover").mockRejectedValue(new Error("Can't reach Yahoo Finance. Check the internet connection."));
    vi.spyOn(api, "watchlist").mockResolvedValue([]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Discover />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Can't reach Yahoo/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
