import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useDesk } from "../desk";
import { api, type WatchItem } from "../lib/api";
import { useDebounced } from "../lib/debounce";
import { arrow, percent, price } from "../lib/format";
import { useQuote, watch } from "../lib/live";
import { cx, Tip } from "./ui";

function SymbolSearch({ onPick, busy }: { onPick: (symbol: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const query = useDebounced(text.trim(), 250);
  const { data: found = [], isFetching } = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search(query),
    enabled: query.length > 0,
    staleTime: 300_000,
  });

  // "/" jumps to the search box from anywhere
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLElement && e.target.closest("input, textarea"))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  const pick = (symbol: string) => {
    onPick(symbol.toUpperCase());
    setText("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-3" />
      <input
        ref={input}
        role="combobox"
        aria-expanded={open && found.length > 0}
        aria-controls="symbol-results"
        aria-label="Add a symbol"
        placeholder="Add a symbol  /"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, found.length - 1));
          else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
          else if (e.key === "Escape") (setText(""), setOpen(false));
          // results still showing an earlier prefix don't count: Enter then takes what was typed
          else if (e.key === "Enter" && text.trim()) pick((query === text.trim() && found[cursor]?.symbol) || text.trim());
          else return;
          e.preventDefault();
        }}
        className="h-8 w-full rounded-md border border-rule bg-raised pr-7 pl-8 text-[13px] text-ink placeholder:text-ink-3 focus:border-buy focus:outline-none"
      />
      {(busy || isFetching) && <LoaderCircle className="absolute top-2 right-2 size-4 animate-spin text-ink-3" />}
      {open && query && found.length > 0 && (
        <ul id="symbol-results" role="listbox" className="absolute top-9 right-0 left-0 z-30 overflow-hidden rounded-lg border border-rule bg-raised py-1 shadow-xl">
          {found.map((r, i) => (
            <li
              key={r.symbol}
              role="option"
              aria-selected={i === cursor}
              onMouseDown={(e) => (e.preventDefault(), pick(r.symbol))}
              onMouseEnter={() => setCursor(i)}
              className={cx("flex cursor-default items-baseline gap-2 px-2.5 py-1.5", i === cursor && "bg-desk")}
            >
              <span className="w-14 shrink-0 font-semibold">{r.symbol}</span>
              <span className="truncate text-ink-2">{r.name}</span>
              <span className="ml-auto text-[11px] text-ink-3">{r.kind === "ETF" ? "ETF" : "Stock"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ item, selected, onSelect, onRemove }: { item: WatchItem; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const quote = useQuote(item.symbol);
  const last = quote?.price_cents ?? item.price_cents;
  const prev = quote?.prev_close_cents ?? item.prev_close_cents;
  const change = last != null && prev ? last / prev - 1 : null;
  const seen = useRef(last);
  const flashed = useRef(0);
  const [tick, setTick] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  useEffect(() => {
    // at most one tint every few seconds: during the session prices change almost every tick
    if (last != null && seen.current != null && last !== seen.current && Date.now() - flashed.current > 3_000) {
      flashed.current = Date.now();
      setTick((t) => ({ dir: last > seen.current! ? "up" : "down", n: (t?.n ?? 0) + 1 }));
    }
    seen.current = last;
  }, [last]);
  const call = item.signal;

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={cx(
          "grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-2 border-l-2 px-3 py-1.5 text-left hover:bg-raised",
          selected ? "border-buy bg-raised" : "border-transparent",
        )}
      >
        <span className="min-w-0">
          <span className="block font-semibold">{item.symbol}</span>
          <span className="block truncate text-[11px] text-ink-3">{item.name}</span>
        </span>
        <span className="text-right">
          <span key={tick?.n} className={cx("num block rounded px-1 font-medium", tick && `tick-${tick.dir}`)}>
            {price(last)}
          </span>
          <span className={cx("num block px-1 text-[11px]", change == null ? "text-ink-3" : change >= 0 ? "text-up" : "text-down")}>
            {arrow(change)} {percent(change, { sign: true })}
          </span>
        </span>
        <Tip
          text={
            !call
              ? "The model is training"
              : call.clear
                ? `Model says ${call.signal.toLowerCase()} for the next day (${percent(call.confidence, { digits: 0 })} sure)`
                : `No clear edge: the model leans ${call.signal.toLowerCase()} (${percent(call.confidence, { digits: 0 })} sure), but calls like this haven't beaten chance`
          }
        >
          <span
            className={cx(
              "grid size-6 place-items-center rounded text-[11px] font-semibold",
              !call || !call.clear ? "border border-rule text-ink-3" : call.signal === "BUY" ? "bg-up/15 text-up" : call.signal === "SELL" ? "bg-down/15 text-down" : "bg-rule/60 text-ink-2",
            )}
          >
            {call ? call.signal[0] : <LoaderCircle className="size-3.5 animate-spin" />}
          </span>
        </Tip>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.symbol} from the watchlist`}
        className="absolute top-1.5 right-0.5 hidden size-5 place-items-center rounded text-ink-3 group-focus-within:grid group-hover:grid hover:text-ink"
      >
        <X className="size-3" />
      </button>
    </li>
  );
}

export function Watchlist() {
  const { symbol, setSymbol } = useDesk();
  const client = useQueryClient();
  const { data: items = [], isLoading } = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlist, refetchInterval: 60_000 });
  useEffect(() => items.forEach((i) => watch(i.symbol)), [items]);

  const add = useMutation({
    mutationFn: api.watch,
    onSuccess: (item) => {
      client.setQueryData<WatchItem[]>(["watchlist"], (old = []) => (old.some((o) => o.symbol === item.symbol) ? old : [...old, item]));
      setSymbol(item.symbol);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: api.unwatch,
    onMutate: (s) => client.setQueryData<WatchItem[]>(["watchlist"], (old = []) => old.filter((o) => o.symbol !== s)),
    onSettled: () => client.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3 pb-2">
        <SymbolSearch onPick={(s) => (items.some((i) => i.symbol === s) ? setSymbol(s) : add.mutate(s))} busy={add.isPending} />
      </div>
      <h2 className="px-3 pb-1 text-[11px] font-medium text-ink-3">Watchlist</h2>
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {items.map((item) => (
          <Row key={item.symbol} item={item} selected={item.symbol === symbol} onSelect={() => setSymbol(item.symbol)} onRemove={() => remove.mutate(item.symbol)} />
        ))}
      </ul>
      {!isLoading && !items.length && <p className="px-3 pb-3 text-ink-2">Add a stock or ETF to follow its price and the model&rsquo;s call.</p>}
    </div>
  );
}
