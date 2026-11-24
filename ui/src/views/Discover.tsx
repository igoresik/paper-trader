import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Change, cx, Empty, Segmented } from "../components/ui";
import { useDesk } from "../desk";
import { api, type DiscoverItem, type WatchItem } from "../lib/api";
import { arrow, percent, price } from "../lib/format";

const ALL = "all";
type Sort = "popular" | "gainers" | "losers" | "month" | "year";
type Kind = "all" | "EQUITY" | "ETF";

const SORTS: { value: Sort; label: string; title: string }[] = [
  { value: "popular", label: "Popular", title: "Most widely held first" },
  { value: "gainers", label: "Gainers", title: "Biggest rise today" },
  { value: "losers", label: "Losers", title: "Biggest fall today" },
  { value: "month", label: "1 month", title: "Best over the last month" },
  { value: "year", label: "1 year", title: "Best over the last year" },
];

const KEY: Record<Sort, keyof DiscoverItem | null> = { popular: null, gainers: "day", losers: "day", month: "month", year: "year" };

/** The chosen order; a symbol with no figure for it (too little history) goes last */
export function sorted(items: DiscoverItem[], sort: Sort): DiscoverItem[] {
  const key = KEY[sort];
  if (!key) return items;
  const sign = sort === "losers" ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = a[key] as number | null;
    const y = b[key] as number | null;
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return sign * (x - y);
  });
}

function Spark({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <div className="h-9" />;
  const lo = Math.min(...points);
  const span = Math.max(...points) - lo || 1;
  const path = points.map((p, i) => `${((i / (points.length - 1)) * 100).toFixed(1)},${(34 - ((p - lo) / span) * 32).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-9 w-full overflow-visible" aria-hidden>
      <polyline points={path} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" className={up ? "stroke-up" : "stroke-down"} />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-ink-3">{label}</span>
      <span className={cx("num font-medium", value == null ? "text-ink-3" : value >= 0 ? "text-up" : "text-down")}>
        {value == null ? "n/a" : `${arrow(value)} ${percent(value, { sign: true, digits: 1 })}`}
      </span>
    </span>
  );
}

function Card({ item, watched, adding, onWatch, onTrade }: { item: DiscoverItem; watched?: WatchItem; adding: boolean; onWatch: () => void; onTrade: () => void }) {
  const call = watched?.signal;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-rule bg-raised p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{item.symbol}</h3>
          <p className="truncate text-[12px] text-ink-2" title={item.name}>{item.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {call?.clear && (
            <span
              title={`The model says ${call.signal.toLowerCase()} for the next day`}
              className={cx("rounded px-1.5 py-0.5 text-[11px] font-semibold", call.signal === "BUY" ? "bg-up/15 text-up" : call.signal === "SELL" ? "bg-down/15 text-down" : "bg-rule/60 text-ink-2")}
            >
              {call.signal}
            </span>
          )}
          {item.kind === "ETF" && <span className="rounded border border-rule px-1.5 py-0.5 text-[11px] text-ink-3">ETF</span>}
        </div>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="num text-[18px] font-semibold">{price(item.price_cents)}</span>
        <Change fraction={item.day} className="text-[13px] font-medium">{percent(item.day, { sign: true })}</Change>
      </div>
      <Spark points={item.spark} up={(item.month ?? item.day) >= 0} />
      <div className="flex justify-between text-[12px]">
        <Stat label="1M" value={item.month} />
        <Stat label="1Y" value={item.year} />
      </div>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={onWatch}
          disabled={!!watched || adding}
          aria-label={watched ? `${item.symbol} is on your watchlist` : `Add ${item.symbol} to your watchlist`}
          className={cx(
            "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[13px] font-medium",
            watched ? "border-rule text-ink-3" : "border-rule text-ink hover:border-buy hover:text-buy",
          )}
        >
          {adding ? <LoaderCircle className="size-3.5 animate-spin" /> : watched ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
          {watched ? "Watching" : "Watch"}
        </button>
        <button type="button" onClick={onTrade} className="h-8 flex-1 rounded-md bg-buy text-[13px] font-medium text-white hover:opacity-90">
          Open chart
        </button>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <li key={i} className="h-[218px] animate-pulse rounded-lg border border-rule bg-raised" />
      ))}
    </ul>
  );
}

export function Discover() {
  const { setSymbol, setView } = useDesk();
  const client = useQueryClient();
  const [category, setCategory] = useState(ALL);
  const [sort, setSort] = useState<Sort>("popular");
  const [kind, setKind] = useState<Kind>("all");
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const filter = useRef<HTMLInputElement>(null);

  const { data, error, isLoading, refetch, isFetching } = useQuery({ queryKey: ["discover"], queryFn: api.discover, staleTime: 300_000 });
  const { data: watchlist = [] } = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlist });
  const watching = useMemo(() => new Map(watchlist.map((w) => [w.symbol, w])), [watchlist]);

  // "/" jumps to the filter box, like the Add a symbol box on the trade view
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea"))) {
        e.preventDefault();
        filter.current?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  const add = useMutation({
    mutationFn: api.watch,
    onMutate: (symbol) => setPending(symbol),
    onSuccess: (item) => {
      client.setQueryData<WatchItem[]>(["watchlist"], (old = []) => (old.some((o) => o.symbol === item.symbol) ? old : [...old, item]));
      toast.success(`${item.symbol} added to your watchlist`);
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPending(null),
  });

  const open = async (symbol: string) => {
    if (!watching.has(symbol)) {
      try {
        await add.mutateAsync(symbol);
      } catch {
        return;
      }
    }
    setSymbol(symbol);
    setView("trade");
  };

  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const items = (data?.items ?? []).filter(
      (i) =>
        (category === ALL || i.categories.includes(category)) &&
        (kind === "all" || i.kind === kind) &&
        (!needle || i.symbol.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle)),
    );
    return sorted(items, sort);
  }, [data, category, kind, text, sort]);

  const current = data?.categories.find((c) => c.id === category);
  const nav = [{ id: ALL, label: "Everything", blurb: "Every stock and ETF on the list", count: data?.items.length ?? 0 }, ...(data?.categories ?? [])];

  return (
    <div className="grid h-full min-h-0 grid-cols-[210px_1fr] bg-desk">
      <nav aria-label="Categories" className="min-h-0 overflow-auto border-r border-rule bg-panel py-3">
        <h2 className="px-4 pb-1.5 text-[11px] font-medium text-ink-3">Browse by category</h2>
        <ul>
          {nav.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setCategory(c.id)}
                aria-current={category === c.id ? "true" : undefined}
                className={cx(
                  "flex w-full items-center justify-between gap-2 border-l-2 px-4 py-1.5 text-left text-[13px]",
                  category === c.id ? "border-buy bg-raised font-medium text-ink" : "border-transparent text-ink-2 hover:bg-raised hover:text-ink",
                )}
              >
                <span className="truncate">{c.label}</span>
                <span className="num text-[11px] text-ink-3">{c.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="flex min-h-0 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule bg-panel px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold">{current?.label ?? "Everything"}</h1>
            <p className="text-[12px] text-ink-2">{current?.blurb ?? "Every stock and ETF on the list"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-3" />
              <input
                ref={filter}
                aria-label="Filter by name or ticker"
                placeholder="Filter  /"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setText("")}
                className="h-8 w-44 rounded-md border border-rule bg-raised pr-7 pl-8 text-[13px] text-ink placeholder:text-ink-3 focus:border-buy focus:outline-none"
              />
              {text && (
                <button type="button" aria-label="Clear the filter" onClick={() => setText("")} className="absolute top-2 right-2 text-ink-3 hover:text-ink">
                  <X className="size-4" />
                </button>
              )}
            </div>
            <Segmented
              label="Show"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "EQUITY", label: "Stocks" },
                { value: "ETF", label: "ETFs" },
              ]}
            />
            <Segmented label="Sort by" value={sort} onChange={setSort} options={SORTS} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <Skeleton />
          ) : error ? (
            <div className="grid place-items-center gap-3 px-6 py-12 text-center">
              <p className="max-w-96 text-ink-2">{error.message}</p>
              <button type="button" onClick={() => refetch()} className="h-8 rounded-md border border-rule px-3 text-[13px] font-medium hover:border-buy hover:text-buy">
                {isFetching ? "Trying…" : "Try again"}
              </button>
            </div>
          ) : !shown.length ? (
            <Empty title="Nothing matches">
              Try another category or clear the filter.
            </Empty>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">
              {shown.map((item) => (
                <Card
                  key={item.symbol}
                  item={item}
                  watched={watching.get(item.symbol)}
                  adding={pending === item.symbol}
                  onWatch={() => add.mutate(item.symbol)}
                  onTrade={() => open(item.symbol)}
                />
              ))}
            </ul>
          )}
        </div>
        <footer className="border-t border-rule bg-panel px-4 py-1.5 text-[11px] text-ink-3">
          {data ? `${shown.length} shown · prices from Yahoo Finance, updated ${new Date(data.updated * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · a curated list, not advice` : "Loading prices…"}
        </footer>
      </section>
    </div>
  );
}
