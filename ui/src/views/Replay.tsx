import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PriceChart } from "../components/PriceChart";
import { ReportTiles, Return } from "../components/ReportTiles";
import { Button, cx, Empty, Input, Segmented } from "../components/ui";
import { useDesk } from "../desk";
import { api, type ChartPrefs, type OrderType, type ReplayState, type Side } from "../lib/api";
import { marketDay, money, parseCents, price, shares } from "../lib/format";

const CASH = [1_000_000, 2_500_000, 10_000_000];
const DAILY_RANGES = ["1m", "3m", "6m", "ytd", "1y", "5y", "all"];

function yearAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function NewReplay({ onStarted }: { onStarted: (s: ReplayState) => void }) {
  const [symbol, setSymbol] = useState("SPY");
  const [day, setDay] = useState(yearAgo);
  const [cash, setCash] = useState(String(CASH[2]));
  const start = useMutation({
    // midnight UTC is still the evening before in New York, so the replay opens on the day picked
    mutationFn: () => api.startReplay(symbol.trim().toUpperCase(), Date.parse(`${day}T00:00:00Z`) / 1000, Number(cash)),
    onSuccess: onStarted,
    onError: (e) => toast.error(e.message),
  });
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <h2 className="text-[13px] font-semibold">New replay</h2>
      <p className="text-[12px] leading-snug text-ink-2">Trade a stretch of the past one day at a time. You only see the days up to the replay&rsquo;s date.</p>
      <label className="grid gap-1 text-[12px] text-ink-2">
        Symbol
        <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
      </label>
      <label className="grid gap-1 text-[12px] text-ink-2">
        Start on
        <Input type="date" value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} />
      </label>
      <Segmented size="sm" label="Starting cash" value={cash} onChange={setCash}
        options={CASH.map((c) => ({ value: String(c), label: money(c).replace(".00", "") }))} />
      <Button type="submit" tone="buy" disabled={start.isPending || !symbol.trim() || !day}>
        {start.isPending ? "Opening…" : "Start replay"}
      </Button>
    </form>
  );
}

function Ticket({ s }: { s: ReplayState }) {
  const client = useQueryClient();
  const [side, setSide] = useState<Side>("BUY");
  const [type, setType] = useState<OrderType>("MARKET");
  const [qty, setQty] = useState("10");
  const [at, setAt] = useState("");
  const id = s.account.id;
  const owned = s.portfolio.positions[0]?.shares ?? 0; // below zero: short
  const shorting = side === "SELL" && owned <= 0;
  const place = useMutation({
    mutationFn: () => {
      const cents = parseCents(at) ?? undefined;
      return api.replayOrder(id, {
        side, type, shares: Number(qty), short: shorting,
        ...(type === "LIMIT" ? { limit_cents: cents } : type === "STOP" ? { stop_cents: cents } : {}),
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["replay", id] }),
    onError: (e) => toast.error(e.message),
  });
  const ok = Number(qty) >= 1 && Number.isInteger(Number(qty)) && (type === "MARKET" || parseCents(at) != null);
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (ok) place.mutate(); }}>
      <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "BUY", label: "Buy" }, { value: "SELL", label: "Sell" }]} />
      <Segmented size="sm" label="Order type" value={type} onChange={setType}
        options={[{ value: "MARKET", label: "Market" }, { value: "LIMIT", label: "Limit" }, { value: "STOP", label: "Stop" }]} />
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-[12px] text-ink-2">
          Shares
          <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        {type !== "MARKET" && (
          <label className="grid gap-1 text-[12px] text-ink-2">
            {type === "LIMIT" ? "Limit" : "Stop"} price
            <Input inputMode="decimal" placeholder={price(s.portfolio.positions[0]?.last_cents ?? null)} value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
      </div>
      <p className="text-[12px] text-ink-2">
        {type === "MARKET" ? "Fills at the next day’s open." : `Fills on a later day once the price ${type === "LIMIT" ? "reaches" : "crosses"} it.`}
      </p>
      <Button type="submit" tone={side === "BUY" ? "buy" : "sell"} disabled={!ok || place.isPending}>
        {side === "BUY" ? (owned < 0 ? "Buy back" : "Buy") : shorting ? "Sell short" : "Sell"} {ok ? shares(Number(qty)) : ""} {s.symbol}
      </Button>
    </form>
  );
}

function Session({ id, onClosed }: { id: number; onClosed: () => void }) {
  const { chart, theme, settings } = useDesk();
  const client = useQueryClient();
  const { data: s, error } = useQuery({ queryKey: ["replay", id], queryFn: () => api.replay(id) });
  // a replay draws daily or weekly bars, keeping the desk's indicators
  const prefs: ChartPrefs = {
    ...chart,
    interval: chart.interval === "1w" ? "1w" : "1d",
    range: DAILY_RANGES.includes(chart.range) ? chart.range : "1y",
  };
  const bars = useQuery({
    queryKey: ["chart", s?.symbol, "replay", id, s?.clock, prefs.interval, prefs.range, s?.orders.length],
    queryFn: () => api.chart(s!.symbol, prefs, id, s!.clock),
    enabled: !!s,
    placeholderData: (previous) => previous,
  });
  const step = useMutation({
    mutationFn: (days: number) => api.stepReplay(id, days),
    onSuccess: ({ fills, state }) => {
      client.setQueryData(["replay", id], state);
      client.invalidateQueries({ queryKey: ["replays"] });
      for (const f of fills)
        toast.success(`${f.buy_in ? "Bought back" : f.side === "BUY" ? "Bought" : "Sold"} ${shares(f.shares)} ${f.symbol} at ${money(f.price_cents)}`, {
          description: f.buy_in ? `${marketDay(f.executed_at)}: forced buy-in, the collateral was down to 130%.` : marketDay(f.executed_at),
        });
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: api.cancelOrder,
    onSuccess: () => client.invalidateQueries({ queryKey: ["replay", id] }),
  });
  const close = useMutation({ mutationFn: () => api.closeReplay(id), onSuccess: onClosed });

  // N moves to the next day, unless someone is typing
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && e.target.closest("input, textarea, [role=dialog]"))) return;
      if ((e.key === "n" || e.key === "N") && s?.days_left && !step.isPending) step.mutate(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [s?.days_left, step]);

  if (error) return <p className="p-6 text-ink-2">{error.message}</p>;
  if (!s) return <p className="flex items-center gap-2 p-6 text-ink-2"><LoaderCircle className="size-4 animate-spin" /> Opening the replay&hellip;</p>;
  const p = s.portfolio;
  const held = p.positions[0];
  const r = s.report;
  const shown = bars.data && bars.data.symbol === s.symbol ? bars.data : undefined;
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_300px]">
      <section className="flex min-h-0 flex-col overflow-auto">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-panel px-3 py-2">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h1 className="text-[15px] font-semibold">{s.symbol}</h1>
            <span className="font-medium">{marketDay(s.clock)}</span>
            <span className="text-ink-2">day {s.days_played + 1}, {s.days_left ? `${s.days_left} to go` : "the last one"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {[[1, "Next day"], [5, "+1 week"], [21, "+1 month"]].map(([days, label]) => (
              <Button key={days} tone={days === 1 ? "buy" : "plain"} disabled={!s.days_left || step.isPending}
                onClick={() => step.mutate(days as number)} title={days === 1 ? "Next day (N)" : undefined}>
                {label}
              </Button>
            ))}
            <Button tone="quiet" onClick={() => close.mutate()} disabled={close.isPending}>Close replay</Button>
          </div>
        </header>
        <div className={cx("relative h-[420px] shrink-0 bg-panel", bars.isFetching && bars.isPlaceholderData && "opacity-60")}>
          {shown ? <PriceChart data={shown} prefs={prefs} theme={theme} updown={settings.updown} /> : (
            <p className="flex items-center gap-2 p-6 text-ink-2"><LoaderCircle className="size-4 animate-spin" /> Loading {s.symbol}&rsquo;s history&hellip;</p>
          )}
        </div>
        <div className="grid gap-2 p-4">
          <h2 className="text-[13px] font-semibold">
            Report card <span className="font-normal text-ink-2">so far, valued at {marketDay(s.clock)}&rsquo;s close</span>
          </h2>
          <ReportTiles
            r={r}
            model={{ label: "Following the model", note: (days) => `its out-of-sample calls, ${days} days`, none: "No out-of-sample calls for these days" }}
          />
          <p className="text-[12px] text-ink-2">
            Since {marketDay(r.since!)}: you <Return value={r.return} />, buying {s.symbol} on day 1 and holding <Return value={r.benchmark_return} />
            {r.model.days ? <>, following the model <Return value={r.model.return} /></> : null}.
          </p>
        </div>
      </section>
      <aside className="min-h-0 overflow-auto border-l border-rule bg-panel p-3" aria-label="Replay orders">
        <Ticket s={s} />
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-rule pt-3 text-[12px]">
          <dt className="text-ink-2">Value</dt><dd className="num text-right font-semibold">{money(p.total_value_cents)}</dd>
          <dt className="text-ink-2">Cash</dt><dd className="num text-right">{money(p.cash_cents)}</dd>
          <dt className="text-ink-2">Shares</dt><dd className="num text-right">{held ? (held.shares < 0 ? `${shares(-held.shares)} short` : shares(held.shares)) : "0"}</dd>
          {held && <><dt className="text-ink-2">Average cost</dt><dd className="num text-right">{money(held.avg_cost_cents)}</dd></>}
          {held && <><dt className="text-ink-2">Unrealized</dt><dd className="text-right"><Return value={held.unrealized_pnl_cents / Math.abs(held.cost_basis_cents)} /></dd></>}
        </dl>
        {s.orders.length > 0 && (
          <section className="mt-4 border-t border-rule pt-3">
            <h3 className="mb-1 text-[12px] font-semibold">Open orders</h3>
            <ul className="grid gap-1 text-[12px]">
              {s.orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2">
                  <span className={o.side === "BUY" ? "text-buy" : "text-sell"}>{o.side === "BUY" ? "Buy" : "Sell"} {o.shares}</span>
                  <span className="num text-ink-2">{o.type === "MARKET" ? "at the open" : `${o.type === "LIMIT" ? "limit" : "stop"} ${money(o.limit_cents ?? o.stop_cents)}`}</span>
                  <button type="button" aria-label={`Cancel order ${o.id}`} className="text-ink-3 hover:text-ink" onClick={() => cancel.mutate(o.id)}>
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

export function Replay() {
  const client = useQueryClient();
  const [chosen, setChosen] = useState<number | null>(null);
  const list = useQuery({ queryKey: ["replays"], queryFn: api.replays });
  const id = chosen ?? list.data?.[0]?.id ?? null;
  return (
    <div className="grid h-full min-h-0 grid-cols-[256px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-r border-rule bg-panel p-3">
        <NewReplay onStarted={(s) => { client.setQueryData(["replay", s.account.id], s); client.invalidateQueries({ queryKey: ["replays"] }); setChosen(s.account.id); }} />
        {!!list.data?.length && (
          <section className="mt-5">
            <h2 className="mb-1 text-[13px] font-semibold">Your replays</h2>
            <ul className="grid gap-0.5">
              {list.data.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setChosen(r.id)} aria-current={r.id === id}
                    className={cx("w-full rounded-md px-2 py-1.5 text-left hover:bg-raised", r.id === id && "bg-raised")}>
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-[11px] text-ink-2">
                      at {marketDay(r.state.clock)}, <Return value={r.state.report.return} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
      {id ? (
        <Session key={id} id={id} onClosed={() => { setChosen(null); client.invalidateQueries({ queryKey: ["replays"] }); }} />
      ) : (
        <Empty title="No replays yet">Pick a symbol and a start date, then play the days forward one at a time.</Empty>
      )}
    </div>
  );
}
