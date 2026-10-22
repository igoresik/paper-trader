import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs } from "radix-ui";
import { toast } from "sonner";

import { useDesk } from "../desk";
import { api, type Order, type Portfolio, type Position } from "../lib/api";
import { dateTime, money, percent, price, shares } from "../lib/format";
import { useQuote } from "../lib/live";
import { Button, Change, cx, Empty } from "./ui";

const th = "px-3 py-1.5 text-left text-[11px] font-medium text-ink-3";
const td = "px-3 py-1.5";

export function PositionRow({ p, total, onPick, wide }: { p: Position; total?: number; onPick?: () => void; wide?: boolean }) {
  const { trade } = useDesk();
  const quote = useQuote(p.symbol);
  const last = quote?.price_cents ?? p.last_cents;
  const value = p.shares * last;
  const unrealized = value - p.cost_basis_cents;
  const today = p.day_change_cents + p.shares * (last - p.last_cents);
  return (
    <tr className="border-t border-rule hover:bg-raised/60">
      <td className={td}>
        <button type="button" className="font-semibold hover:text-buy" onClick={onPick}>
          {p.symbol}
        </button>
      </td>
      <td className={cx(td, "num text-right")}>{p.shares < 0 ? `${shares(-p.shares)} short` : shares(p.shares)}</td>
      <td className={cx(td, "num text-right")}>{price(p.avg_cost_cents)}</td>
      <td className={cx(td, "num text-right")}>{price(last)}</td>
      <td className={cx(td, "num text-right")}>{money(value)}</td>
      <td className={cx(td, "text-right")}>
        <Change cents={today}>{money(today, { sign: true })}</Change>
      </td>
      <td className={cx(td, "text-right")}>
        <Change cents={unrealized}>
          {money(unrealized, { sign: true })} <span className="text-[11px]">{percent(unrealized / Math.abs(p.cost_basis_cents), { sign: true, digits: 1 })}</span>
        </Change>
      </td>
      {wide && total ? (
        <td className={cx(td, "w-36")}>
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-rule">
              <div className="h-1.5 rounded-full bg-ink-2" style={{ width: `${(Math.abs(value) / total) * 100}%` }} />
            </div>
            <span className="num w-10 text-right text-[11px] text-ink-2">{percent(Math.abs(value) / total, { digits: 0 })}</span>
          </div>
        </td>
      ) : null}
      <td className={cx(td, "text-right")}>
        {p.shares < 0 ? (
          <Button tone="quiet" className="h-6 px-2 text-xs" onClick={() => trade(p.symbol, "BUY", -p.shares)}>
            Buy back
          </Button>
        ) : (
          <Button tone="quiet" className="h-6 px-2 text-xs" onClick={() => trade(p.symbol, "SELL", p.shares)}>
            Sell
          </Button>
        )}
      </td>
    </tr>
  );
}

export function PositionsTable({ portfolio, wide }: { portfolio: Portfolio | undefined; wide?: boolean }) {
  const { setSymbol } = useDesk();
  if (!portfolio?.positions.length) return <Empty title="No positions yet">Your buys show up here, valued at live prices.</Empty>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>Symbol</th>
          <th className={cx(th, "text-right")}>Shares</th>
          <th className={cx(th, "text-right")}>Avg cost</th>
          <th className={cx(th, "text-right")}>Last</th>
          <th className={cx(th, "text-right")}>Value</th>
          <th className={cx(th, "text-right")}>Today</th>
          <th className={cx(th, "text-right")}>Unrealized</th>
          {wide && <th className={th}>Share of portfolio</th>}
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {portfolio.positions.map((p) => (
          <PositionRow key={p.symbol} p={p} wide={wide} total={portfolio.total_value_cents} onPick={() => setSymbol(p.symbol)} />
        ))}
      </tbody>
    </table>
  );
}

function OrdersTable({ accountId }: { accountId: number }) {
  const client = useQueryClient();
  const { data: orders = [] } = useQuery({ queryKey: ["orders", accountId], queryFn: () => api.orders(accountId) });
  const cancel = useMutation({
    mutationFn: api.cancelOrder,
    onSuccess: (o: Order) => {
      toast(`Cancelled ${o.type.toLowerCase()} ${o.side.toLowerCase()} for ${shares(o.shares)} ${o.symbol}`);
      for (const queryKey of [["orders"], ["portfolio"], ["chart", o.symbol]]) client.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error(e.message),
  });
  if (!orders.length) return <Empty title="No open orders">Limit and stop orders wait here until their price comes, even while the app is closed.</Empty>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>Symbol</th>
          <th className={th}>Order</th>
          <th className={cx(th, "text-right")}>Shares</th>
          <th className={cx(th, "text-right")}>Price</th>
          <th className={th}>Placed</th>
          <th className={th} />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} className="border-t border-rule">
            <td className={cx(td, "font-semibold")}>{o.symbol}</td>
            <td className={td}>
              <span className={o.side === "BUY" ? "text-buy" : "text-sell"}>{o.side === "BUY" ? "Buy" : "Sell"}</span>{" "}
              {o.type === "MARKET" ? "at the open" : o.type.toLowerCase()}
            </td>
            <td className={cx(td, "num text-right")}>{shares(o.shares)}</td>
            <td className={cx(td, "num text-right")}>{price(o.limit_cents ?? o.stop_cents)}</td>
            <td className={cx(td, "text-ink-2")}>{dateTime(o.created_at)}</td>
            <td className={cx(td, "text-right")}>
              <Button tone="quiet" className="h-6 px-2 text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
                Cancel
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FillsTable({ accountId, pageSize = 20 }: { accountId: number; pageSize?: number }) {
  const { data } = useQuery({ queryKey: ["history", accountId, 1, pageSize], queryFn: () => api.history(accountId, 1, pageSize) });
  if (!data?.items.length) return <Empty title="No trades yet">Every fill is kept here for good; the ledger can't be edited.</Empty>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <th className={th}>Time</th>
          <th className={th}>Symbol</th>
          <th className={th}>Side</th>
          <th className={cx(th, "text-right")}>Shares</th>
          <th className={cx(th, "text-right")}>Price</th>
          <th className={cx(th, "text-right")}>Total</th>
          <th className={cx(th, "text-right")}>Realized</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((t) => (
          <tr key={t.id} className="border-t border-rule">
            <td className={cx(td, "text-ink-2")}>{dateTime(t.executed_at)}</td>
            <td className={cx(td, "font-semibold")}>{t.symbol}</td>
            <td className={cx(td, t.side === "BUY" ? "text-buy" : "text-sell")}>{t.side === "BUY" ? "Buy" : "Sell"}</td>
            <td className={cx(td, "num text-right")}>{shares(t.shares)}</td>
            <td className={cx(td, "num text-right")}>{price(t.price_cents)}</td>
            <td className={cx(td, "num text-right")}>{money(t.total_cents)}</td>
            <td className={cx(td, "text-right")}>
              {t.realized_pnl_cents == null ? <span className="text-ink-3">{"—"}</span> : <Change cents={t.realized_pnl_cents}>{money(t.realized_pnl_cents, { sign: true })}</Change>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Blotter({ portfolio }: { portfolio: Portfolio | undefined }) {
  const { accountId } = useDesk();
  const { data: orders = [] } = useQuery({ queryKey: ["orders", accountId], queryFn: () => api.orders(accountId!), enabled: !!accountId });
  const tab = "h-9 border-b-2 border-transparent px-1 text-[13px] text-ink-2 hover:text-ink data-[state=active]:border-buy data-[state=active]:text-ink";
  return (
    <Tabs.Root defaultValue="positions" className="flex h-full min-h-0 flex-col border-t border-rule bg-panel">
      <Tabs.List className="flex gap-5 border-b border-rule px-3" aria-label="Positions and orders">
        <Tabs.Trigger value="positions" className={tab}>
          Positions {portfolio?.positions.length ? <span className="num text-ink-3">{portfolio.positions.length}</span> : null}
        </Tabs.Trigger>
        <Tabs.Trigger value="orders" className={tab}>
          Orders {orders.length ? <span className="num text-ink-3">{orders.length}</span> : null}
        </Tabs.Trigger>
        <Tabs.Trigger value="fills" className={tab}>
          Fills
        </Tabs.Trigger>
      </Tabs.List>
      <div className="min-h-0 flex-1 overflow-auto">
        <Tabs.Content value="positions">
          <PositionsTable portfolio={portfolio} />
        </Tabs.Content>
        <Tabs.Content value="orders">{accountId && <OrdersTable accountId={accountId} />}</Tabs.Content>
        <Tabs.Content value="fills">{accountId && <FillsTable accountId={accountId} />}</Tabs.Content>
      </div>
    </Tabs.Root>
  );
}
