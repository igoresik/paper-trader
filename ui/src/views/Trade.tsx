import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

import { Blotter } from "../components/Blotter";
import { ChartToolbar } from "../components/ChartToolbar";
import { PriceChart } from "../components/PriceChart";
import { SignalCard } from "../components/SignalCard";
import { Ticket } from "../components/Ticket";
import { Change } from "../components/ui";
import { Watchlist } from "../components/Watchlist";
import { useDesk } from "../desk";
import { api, type Portfolio } from "../lib/api";
import { money, percent } from "../lib/format";
import { useQuote, watch } from "../lib/live";

function ChartPanel() {
  const { symbol, chart, save, accountId, theme, settings } = useDesk();
  const client = useQueryClient();
  const quote = useQuote(symbol);
  const { data, error, isFetching, isPlaceholderData } = useQuery({
    queryKey: ["chart", symbol, chart, accountId],
    queryFn: () => api.chart(symbol, chart, accountId),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
  useEffect(() => watch(symbol), [symbol]);

  // a new session's first price: fetch again so the server adds the bar that just started
  const asked = useRef(0);
  useEffect(() => {
    if (data && !data.forming && quote?.session === "regular" && Date.now() - asked.current > 60_000) {
      asked.current = Date.now();
      client.invalidateQueries({ queryKey: ["chart", symbol] });
    }
  }, [quote?.session, data, symbol, client]);

  const last = quote?.price_cents ?? data?.bars.c.at(-1) ?? null;
  const prev = quote?.prev_close_cents ?? (data && data.bars.c.length > 1 ? data.bars.c.at(-2)! : null);
  const change = last != null && prev ? last - prev : null;
  const shown = data && data.symbol === symbol ? data : undefined;

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr] bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="text-[15px] font-semibold">{symbol}</h1>
          <span className="truncate text-ink-2">{shown?.name}</span>
          <span className="num text-[15px] font-semibold">{money(last)}</span>
          {change != null && prev ? (
            <Change cents={change} className="text-[12px]">
              {money(change, { sign: true })} ({percent(change / prev, { sign: true })})
            </Change>
          ) : null}
          {quote?.ext_price_cents && quote.session !== "regular" ? (
            <span className="num text-[12px] text-ink-2">
              {quote.ext_session === "pre" ? "Pre-market" : "After hours"} {money(quote.ext_price_cents)}
            </span>
          ) : null}
        </div>
        <ChartToolbar prefs={chart} onChange={(next) => save({ chart: next })} />
      </div>
      <div className={isFetching && isPlaceholderData ? "relative min-h-0 opacity-60" : "relative min-h-0"}>
        {error && !shown ? (
          <p className="p-6 text-ink-2">{error.message}</p>
        ) : shown ? (
          <PriceChart data={shown} prefs={chart} theme={theme} updown={settings.updown} />
        ) : (
          <p className="flex items-center gap-2 p-6 text-ink-2">
            <LoaderCircle className="size-4 animate-spin" /> Loading {symbol}&rsquo;s history&hellip;
          </p>
        )}
      </div>
    </div>
  );
}

export function Trade({ portfolio }: { portfolio: Portfolio | undefined }) {
  const { symbol } = useDesk();
  const { data: watchlist = [] } = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlist });
  const lastPrice = watchlist.find((w) => w.symbol === symbol)?.price_cents ?? null;
  return (
    <div className="grid h-full min-h-0 grid-cols-[256px_minmax(0,1fr)_328px]">
      <aside className="min-h-0 border-r border-rule bg-panel">
        <Watchlist />
      </aside>
      <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_236px]">
        <ChartPanel />
        <Blotter portfolio={portfolio} />
      </section>
      <aside className="min-h-0 overflow-auto border-l border-rule bg-panel p-3" aria-label="Trade">
        <Ticket portfolio={portfolio} lastPrice={lastPrice} />
        <SignalCard />
      </aside>
    </div>
  );
}
