import { X } from "lucide-react";

import type { Order, Trade } from "../lib/api";
import { dateTime, money, shares } from "../lib/format";

const isTrade = (r: Trade | Order): r is Trade => "price_cents" in r;

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 leading-7 ${strong ? "font-medium" : ""}`}>
      <span>{label}</span>
      <span className="num text-right">{value}</span>
    </div>
  );
}

/** The slip a filled or placed order prints. Monospace, like the receipts it is named after. */
export function Receipt({ receipt, onClose }: { receipt: Trade | Order; onClose: () => void }) {
  const filled = isTrade(receipt);
  const buy = receipt.side === "BUY";
  const stamp = filled ? (buy ? "Bought" : "Sold") : receipt.queued ? "Queued" : "Placed";
  const tone = filled ? (buy ? "var(--buy)" : "var(--sell)") : "var(--paper-ink)";
  return (
    <div className="printing paper perforated relative mt-2 rounded-t-md px-4 pt-3 pb-5 font-mono text-[12px]" role="status">
      <button
        type="button"
        onClick={onClose}
        aria-label="Put the receipt away"
        className="press absolute top-2 right-2 grid size-6 place-items-center rounded text-paper-ink/60 hover:text-paper-ink"
      >
        <X className="size-3.5" />
      </button>
      <div className="ruled">
        <div className="flex justify-between leading-7">
          <span>Order #{filled ? receipt.order_id : receipt.id}</span>
          <span>{dateTime(filled ? receipt.executed_at : receipt.created_at)}</span>
        </div>
        <Line label={`${receipt.side} ${receipt.type}`} value={`${shares(receipt.shares)} ${receipt.symbol}`} />
        {filled ? (
          <>
            <Line label="Price" value={money(receipt.price_cents)} />
            <Line label="Commission" value={money(receipt.commission_cents)} />
            <Line label={buy ? "Total paid" : "Total received"} value={money(receipt.total_cents)} strong />
            {receipt.realized_pnl_cents != null && <Line label="Realized P&L" value={money(receipt.realized_pnl_cents, { sign: true })} />}
            <Line label="Cash after" value={money(receipt.cash_after_cents)} />
          </>
        ) : (
          <>
            {receipt.limit_cents != null && <Line label="Limit" value={money(receipt.limit_cents)} />}
            {receipt.stop_cents != null && <Line label="Stop" value={money(receipt.stop_cents)} />}
            {buy && <Line label="Cash held" value={money(receipt.reserved_cents)} />}
          </>
        )}
      </div>
      <p className="mt-2 font-sans text-[11px] text-paper-ink/70">
        {filled
          ? receipt.practice
            ? "Practice fill at the last price, because the market is closed."
            : "Filled at the live price."
          : receipt.queued
            ? "The market is closed, so this fills at the next open. Cancel it any time under Orders."
            : "Waiting for its price, even while the app is closed. Cancel it any time under Orders."}
      </p>
      <span
        className="stamp pointer-events-none absolute right-4 bottom-4 rounded border-2 px-2 py-0.5 font-sans text-sm font-semibold tracking-wide uppercase"
        style={{ color: tone, borderColor: tone }}
        aria-hidden
      >
        {stamp}
      </span>
    </div>
  );
}
