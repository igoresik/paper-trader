// Live updates over /ws: quotes go into a small store that components subscribe to per symbol;
// everything else refreshes the matching queries.

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { Order, Quote, Status, Trade } from "./api";
import { money, shares } from "./format";

type Listener = () => void;

const quotes = new Map<string, Quote>();
const quoteListeners = new Map<string, Set<Listener>>();
let status: Status = { session: "closed", stream: "connecting", live: false };
const statusListeners = new Set<Listener>();
const jobListeners = new Set<(symbol: string, progress: number) => void>();
const watched = new Set<string>();
// fills this window already showed as a receipt, so they don't toast as well
const shown = new Set<number>();
let socket: WebSocket | null = null;

function putQuote(quote: Quote) {
  quotes.set(quote.symbol, { ...quotes.get(quote.symbol), ...quote });
  quoteListeners.get(quote.symbol)?.forEach((listen) => listen());
  quoteVersion += 1;
  anyQuote.forEach((listen) => listen());
}

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next };
  statusListeners.forEach((listen) => listen());
}

export function useQuote(symbol: string | null): Quote | undefined {
  return useSyncExternalStore(
    (listen) => {
      if (!symbol) return () => {};
      const set = quoteListeners.get(symbol) ?? new Set();
      quoteListeners.set(symbol, set.add(listen));
      return () => set.delete(listen);
    },
    () => (symbol ? quotes.get(symbol) : undefined),
  );
}

const anyQuote = new Set<Listener>();
let quoteVersion = 0;

/** Re-renders on every quote, for totals that span many symbols. */
export function useQuotesVersion(): number {
  return useSyncExternalStore(
    (listen) => {
      anyQuote.add(listen);
      return () => anyQuote.delete(listen);
    },
    () => quoteVersion,
  );
}

export function useStatus(): Status {
  return useSyncExternalStore(
    (listen) => {
      statusListeners.add(listen);
      return () => statusListeners.delete(listen);
    },
    () => status,
  );
}

export function onJob(listen: (symbol: string, progress: number) => void) {
  jobListeners.add(listen);
  return () => {
    jobListeners.delete(listen);
  };
}

/** The latest regular-session price we have heard, if any. */
export const livePrice = (symbol: string) => quotes.get(symbol)?.price_cents;

export function markShown(tradeId: number) {
  shown.add(tradeId);
}

export function watch(symbol: string) {
  watched.add(symbol);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "watch", symbol }));
}

export function connect(client: QueryClient) {
  let delay = 1000;
  const refresh = (...keys: unknown[][]) => keys.forEach((queryKey) => client.invalidateQueries({ queryKey }));

  const handle = (event: { type: string } & Record<string, unknown>) => {
    switch (event.type) {
      case "hello":
        (event.quotes as Quote[]).forEach(putQuote);
        setStatus(event as unknown as Status);
        break;
      case "quote":
        putQuote(event as unknown as Quote);
        break;
      case "quotes":
        (event.quotes as Quote[]).forEach(putQuote);
        break;
      case "status":
        setStatus(event as unknown as Status);
        break;
      case "fill": {
        const fill = event as unknown as Trade;
        refresh(["portfolio"], ["orders"], ["history"], ["chart", fill.symbol], ["equity"]);
        if (!shown.has(fill.id)) {
          const verb = fill.side === "BUY" ? "Bought" : "Sold";
          toast.success(`${verb} ${shares(fill.shares)} ${fill.symbol} at ${money(fill.price_cents)}`, {
            description: fill.type === "MARKET" ? "Your queued market order filled at the open." : `Your ${fill.type.toLowerCase()} order filled.`,
          });
        }
        break;
      }
      case "rejected":
        refresh(["portfolio"], ["orders"]);
        toast.error(`Order for ${event.symbol} was rejected`, { description: String(event.reason) });
        break;
      case "order":
        refresh(["portfolio"], ["orders"], ["chart", (event as unknown as Order).symbol]);
        break;
      case "signal":
      case "history":
        refresh(["watchlist"], ["signal", event.symbol], ["chart", event.symbol]);
        break;
      case "job":
        jobListeners.forEach((listen) => listen(String(event.symbol), Number(event.progress)));
        break;
    }
  };

  const open = () => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onopen = () => {
      delay = 1000;
      watched.forEach((symbol) => socket?.send(JSON.stringify({ type: "watch", symbol })));
    };
    socket.onmessage = (message) => handle(JSON.parse(message.data));
    socket.onclose = () => {
      setStatus({ stream: "offline" });
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();
}
