import { useQuery } from "@tanstack/react-query";
import { Settings as Gear } from "lucide-react";

import { useDesk, type View } from "../desk";
import { api, type Portfolio } from "../lib/api";
import { money, percent } from "../lib/format";
import { livePrice, useQuotesVersion, useStatus } from "../lib/live";
import { Change, cx, IconButton, Select } from "./ui";

/** Portfolio value at the newest prices heard, between refetches. */
export function useLiveTotals(p: Portfolio | undefined) {
  useQuotesVersion();
  if (!p) return null;
  let value = p.cash_cents;
  let today = p.day_change_cents;
  for (const pos of p.positions) {
    const last = livePrice(pos.symbol) ?? pos.last_cents;
    value += pos.shares * last;
    today += pos.shares * (last - pos.last_cents);
  }
  return { value, today, start: p.total_value_cents - p.day_change_cents };
}

function Market() {
  const s = useStatus();
  const state = s.live ? "Market open" : s.session === "pre" ? "Pre-market" : s.session === "post" ? "After hours" : s.session === "regular" ? "Market quiet" : "Market closed";
  const stream = s.stream === "live" ? "Live prices" : s.stream === "reconnecting" || s.stream === "connecting" ? "Connecting to prices" : "Prices offline";
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-2">
      <span className="flex items-center gap-1.5">
        <i className={cx("size-1.5 rounded-full", s.live ? "bg-up" : "bg-ink-3")} aria-hidden />
        {state}
      </span>
      <span className={cx("flex items-center gap-1.5", s.stream !== "live" && "text-warn")}>
        <i className={cx("size-1.5 rounded-full", s.stream === "live" ? "bg-buy" : "bg-warn")} aria-hidden />
        {stream}
      </span>
      {s.update && (
        <a href={s.update.url} target="_blank" rel="noreferrer" className="text-buy hover:underline">
          Version {s.update.version} is out
        </a>
      )}
    </div>
  );
}

export function TopBar({ portfolio, onSettings }: { portfolio: Portfolio | undefined; onSettings: () => void }) {
  const { accountId, save, view, setView } = useDesk();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  const totals = useLiveTotals(portfolio);
  const views: { value: View; label: string }[] = [
    { value: "trade", label: "Trade" },
    { value: "portfolio", label: "Portfolio" },
    { value: "replay", label: "Replay" },
    { value: "lab", label: "Model lab" },
  ];
  return (
    <header className="flex h-12 shrink-0 items-center gap-5 border-b border-rule bg-panel px-3">
      <div className="flex items-center gap-2">
        <img src="/icon.svg" alt="" className="size-6" />
        <span className="font-semibold">Paper Trader</span>
      </div>
      {accounts.length > 0 && accountId && (
        <Select
          label="Portfolio"
          value={String(accountId)}
          onChange={(id) => save({ account_id: Number(id) })}
          options={accounts.map((a) => ({ value: String(a.id), label: a.name }))}
        />
      )}
      {totals && (
        <div className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold">{money(totals.value)}</span>
          <Change cents={totals.today} className="text-[12px]">
            {money(totals.today, { sign: true })} ({percent(totals.start ? totals.today / totals.start : 0, { sign: true })}) today
          </Change>
        </div>
      )}
      <Market />
      <nav className="ml-auto flex items-center gap-1" aria-label="Views">
        {views.map((v) => (
          <button
            key={v.value}
            type="button"
            aria-current={view === v.value ? "page" : undefined}
            onClick={() => setView(v.value)}
            className={cx("h-8 rounded-md px-3 text-[13px] font-medium", view === v.value ? "bg-raised text-ink" : "text-ink-2 hover:text-ink")}
          >
            {v.label}
          </button>
        ))}
        <IconButton label="Settings" onClick={onSettings} className="ml-1">
          <Gear className="size-4" />
        </IconButton>
      </nav>
    </header>
  );
}
