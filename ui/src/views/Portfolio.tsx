import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";

import { PositionsTable } from "../components/Blotter";
import { ReportTiles, Return } from "../components/ReportTiles";
import { LineChart } from "../components/LineChart";
import { useLiveTotals } from "../components/TopBar";
import { Button, Change, cx, Empty, Input, Segmented } from "../components/ui";
import { useDesk } from "../desk";
import { api, type Portfolio, type Side } from "../lib/api";
import { useDebounced } from "../lib/debounce";
import { dateTime, marketDay, money, percent, price, shares } from "../lib/format";

function Figure({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div className="min-w-0 px-5 first:pl-0">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className={cx("mt-0.5 font-semibold", big ? "text-[26px] leading-tight" : "text-[15px]")}>{children}</div>
    </div>
  );
}

function Report({ accountId }: { accountId: number }) {
  const { data: r } = useQuery({ queryKey: ["equity", "report", accountId], queryFn: () => api.report(accountId) });
  if (!r) return null;
  return (
    <section aria-labelledby="report-title">
      <h2 id="report-title" className="mb-2 text-[13px] font-semibold">
        Report card <span className="font-normal text-ink-2">the same honest test the model gets, applied to you</span>
      </h2>
      <ReportTiles
        r={r}
        model={{ label: "Following SPY's model", note: (days) => `long on its buy calls, ${days} days with a call`, none: "No live calls on SPY yet" }}
      />
      <p className="mt-2 text-[12px] text-ink-2">
        {r.since == null || r.return == null ? "The comparison with SPY and the model starts after your first close." : (
          <>
            Since {marketDay(r.since)}: you <Return value={r.return} />, SPY <Return value={r.spy_return} />
            {r.model.days ? <>, following SPY&rsquo;s model <Return value={r.model.return} /></> : null}.
          </>
        )}
      </p>
    </section>
  );
}

function Equity({ accountId }: { accountId: number }) {
  const { theme } = useDesk();
  const [range, setRange] = useState("all");
  const [asTable, setAsTable] = useState(false);
  const { data } = useQuery({ queryKey: ["equity", accountId, range], queryFn: () => api.equity(accountId, range) });
  const lines = useMemo(
    () => (data ? [
      { label: "This portfolio", color: "--buy", values: data.equity_index },
      { label: data.benchmark, color: "--ink-3", values: data.benchmark_index },
    ] : []),
    [data],
  );
  return (
    <section aria-labelledby="equity-title">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="equity-title" className="text-[13px] font-semibold">
          Growth of $100 <span className="font-normal text-ink-2">against {data?.benchmark ?? "SPY"}, at each day&rsquo;s close</span>
        </h2>
        <div className="flex items-center gap-2">
          <Segmented size="sm" label="Range" value={range} onChange={setRange} options={[{ value: "1m", label: "1M" }, { value: "3m", label: "3M" }, { value: "ytd", label: "YTD" }, { value: "1y", label: "1Y" }, { value: "all", label: "All" }]} />
          <Button className="h-7 px-2 text-xs" onClick={() => setAsTable(!asTable)}>
            {asTable ? "Show chart" : "Show table"}
          </Button>
        </div>
      </div>
      {!data ? null : data.t.length < 2 ? (
        <Empty title="The curve starts after your first close">Each trading day adds a point; until then the portfolio sits at 100.</Empty>
      ) : asTable ? (
        <div className="max-h-64 overflow-auto rounded-md border border-rule">
          <table className="w-full text-right">
            <thead className="sticky top-0 bg-panel text-[11px] text-ink-3">
              <tr><th className="px-3 py-1.5 text-left font-medium">Day</th><th className="px-3 font-medium">Value</th><th className="px-3 font-medium">Portfolio</th><th className="px-3 font-medium">{data.benchmark}</th></tr>
            </thead>
            <tbody>
              {data.t.map((t, i) => (
                <tr key={t} className="num border-t border-rule">
                  <td className="px-3 py-1 text-left">{marketDay(t)}</td>
                  <td className="px-3">{money(data.equity_cents[i])}</td>
                  <td className="px-3">{data.equity_index[i].toFixed(1)}</td>
                  <td className="px-3">{data.benchmark_index[i]?.toFixed(1) ?? "—"}</td>
                </tr>
              )).reverse()}
            </tbody>
          </table>
        </div>
      ) : (
        <LineChart t={data.t} lines={lines} theme={theme} />
      )}
    </section>
  );
}

function History({ accountId }: { accountId: number }) {
  const [page, setPage] = useState(1);
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"ALL" | Side>("ALL");
  const size = 25;
  const filter = useDebounced(symbol.trim().toUpperCase(), 300);
  const { data } = useQuery({
    queryKey: ["history", accountId, page, size, filter, side],
    queryFn: () => api.history(accountId, page, size, filter, side === "ALL" ? undefined : side),
    placeholderData: (previous) => previous,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / size)) : 1;
  return (
    <section aria-labelledby="history-title">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="history-title" className="text-[13px] font-semibold">
          Trade ledger <span className="font-normal text-ink-2">every fill, kept for good</span>
        </h2>
        <div className="flex items-center gap-2">
          <Input placeholder="Symbol" value={symbol} onChange={(e) => (setSymbol(e.target.value), setPage(1))} className="h-7 w-24" aria-label="Filter by symbol" />
          <Segmented size="sm" label="Side" value={side} onChange={(v) => (setSide(v), setPage(1))} options={[{ value: "ALL", label: "All" }, { value: "BUY", label: "Buys" }, { value: "SELL", label: "Sells" }]} />
          <a href={api.historyCsvUrl(accountId)} download className="press inline-flex h-7 items-center gap-1.5 rounded-md border border-rule bg-raised px-2 text-xs font-medium hover:border-ink-3">
            <Download className="size-3.5" /> CSV
          </a>
        </div>
      </div>
      {!data?.items.length ? (
        <Empty title={symbol || side !== "ALL" ? "Nothing matches" : "No trades yet"} />
      ) : (
        <>
          <table className="w-full">
            <thead className="text-[11px] text-ink-3">
              <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                <th className="text-left">Time</th><th className="text-left">Symbol</th><th className="text-left">Order</th>
                <th className="text-right">Shares</th><th className="text-right">Price</th><th className="text-right">Commission</th>
                <th className="text-right">Total</th><th className="text-right">Realized</th><th className="text-right">Cash after</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id} className="border-t border-rule [&>td]:px-3 [&>td]:py-1.5">
                  <td className="text-ink-2">{dateTime(t.executed_at)}</td>
                  <td className="font-semibold">{t.symbol}</td>
                  <td><span className={t.side === "BUY" ? "text-buy" : "text-sell"}>{t.side === "BUY" ? "Buy" : "Sell"}</span> {t.type.toLowerCase()}</td>
                  <td className="num text-right">{shares(t.shares)}</td>
                  <td className="num text-right">{price(t.price_cents)}</td>
                  <td className="num text-right">{price(t.commission_cents)}</td>
                  <td className="num text-right">{money(t.total_cents)}</td>
                  <td className="text-right">{t.realized_pnl_cents == null ? <span className="text-ink-3">{"—"}</span> : <Change cents={t.realized_pnl_cents}>{money(t.realized_pnl_cents, { sign: true })}</Change>}</td>
                  <td className="num text-right">{money(t.cash_after_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-end gap-2 text-[12px] text-ink-2">
            <span className="num">
              Page {page} of {pages}, {data.total} trades
            </span>
            <Button className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button className="h-7 px-2 text-xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
        </>
      )}
    </section>
  );
}

export function PortfolioView({ portfolio }: { portfolio: Portfolio | undefined }) {
  const { accountId } = useDesk();
  const totals = useLiveTotals(portfolio);
  if (!portfolio || !accountId || !totals) return null;
  const unrealized = totals.value - portfolio.cash_cents - portfolio.positions.reduce((sum, p) => sum + p.cost_basis_cents, 0);
  const sinceStart = totals.value - portfolio.account.starting_cash_cents;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-[1200px] gap-8 p-5">
        <div className="flex flex-wrap items-end divide-x divide-rule">
          <Figure label={portfolio.account.name} big>{money(totals.value)}</Figure>
          <Figure label="Today"><Change cents={totals.today}>{money(totals.today, { sign: true })}</Change></Figure>
          <Figure label="Since the start">
            <Change cents={sinceStart}>{money(sinceStart, { sign: true })} <span className="text-[12px]">{percent(sinceStart / portfolio.account.starting_cash_cents, { sign: true })}</span></Change>
          </Figure>
          <Figure label="Cash">{money(portfolio.cash_cents)}</Figure>
          <Figure label="Buying power">{money(portfolio.buying_power_cents)}</Figure>
          <Figure label="Unrealized"><Change cents={unrealized}>{money(unrealized, { sign: true })}</Change></Figure>
          <Figure label="Realized"><Change cents={portfolio.realized_pnl_cents}>{money(portfolio.realized_pnl_cents, { sign: true })}</Change></Figure>
        </div>
        <Equity accountId={accountId} />
        <Report accountId={accountId} />
        <section aria-labelledby="positions-title">
          <h2 id="positions-title" className="mb-2 text-[13px] font-semibold">Positions</h2>
          <PositionsTable portfolio={portfolio} wide />
        </section>
        <History accountId={accountId} />
      </div>
    </div>
  );
}
