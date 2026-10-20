import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useDesk } from "../desk";
import { api, ApiError, type Order, type OrderType, type Portfolio, type Side, type Trade } from "../lib/api";
import { money, parseCents, shares as fmtShares } from "../lib/format";
import { markShown, useQuote, useStatus } from "../lib/live";
import { Receipt } from "./Receipt";
import { cx } from "./ui";

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

/** Same arithmetic as the ledger: slippage and commission always round against the trader. */
function estimate(side: Side, n: number, priceCents: number, slip: boolean, s: { commission_cents: number; commission_bps: number; slippage_bps: number }) {
  const bps = slip ? s.slippage_bps : 0;
  const price = side === "BUY" ? ceilDiv(priceCents * (10_000 + bps), 10_000) : Math.max(1, Math.floor((priceCents * (10_000 - bps)) / 10_000));
  const value = n * price;
  const fee = s.commission_cents + ceilDiv(value * s.commission_bps, 10_000);
  return { price, fee, total: side === "BUY" ? value + fee : value - fee };
}

const paperInput =
  "num h-9 w-full rounded-md border border-paper-rule bg-white/80 px-2.5 font-mono text-[13px] text-paper-ink placeholder:text-paper-ink/40 focus:border-buy focus:outline-none";

export function Ticket({ portfolio, lastPrice }: { portfolio: Portfolio | undefined; lastPrice: number | null }) {
  const { symbol, accountId, settings, preset } = useDesk();
  const client = useQueryClient();
  const quote = useQuote(symbol);
  const status = useStatus();
  const [side, setSide] = useState<Side>("BUY");
  const [type, setType] = useState<OrderType>("MARKET");
  const [mode, setMode] = useState<"shares" | "amount">("shares");
  const [qty, setQty] = useState("10");
  const [amount, setAmount] = useState("1000");
  const [limit, setLimit] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<Trade | Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = quote?.session === "regular" && quote.price_cents ? quote.price_cents : null;
  const ref = live ?? quote?.price_cents ?? lastPrice;
  const position = portfolio?.positions.find((p) => p.symbol === symbol);
  const owned = position?.shares ?? 0;
  const priced = type === "MARKET" ? ref : parseCents(limit);
  const n = mode === "shares" ? (/^\d+$/.test(qty) ? Number(qty) : 0) : priced ? Math.floor((parseCents(amount) ?? 0) / priced) : 0;
  const est = priced && n > 0 ? estimate(side, n, priced, type !== "LIMIT", settings) : null;

  useEffect(() => {
    if (!preset) return;
    setSide(preset.side);
    setType("MARKET");
    if (preset.shares) {
      setMode("shares");
      setQty(String(preset.shares));
    }
    setConfirming(false);
  }, [preset]);

  // a new symbol or order type starts from the current price; later price moves don't overwrite what was typed
  useEffect(() => {
    setLimit(ref ? (ref / 100).toFixed(2) : "");
    setConfirming(false);
    setError(null);
  }, [symbol, type]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 10_000);
    return () => clearTimeout(t);
  }, [confirming]);

  // a confirmation is for one exact order: changing anything asks again
  useEffect(() => setConfirming(false), [side, qty, amount, limit, mode]);

  // B and S pick the side, unless someone is typing
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [role=combobox], [role=dialog]")) return;
      if (e.key === "b" || e.key === "B") setSide("BUY");
      if (e.key === "s" || e.key === "S") setSide("SELL");
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  const send = useMutation({
    mutationFn: async () => {
      if (!accountId) throw new ApiError(400, "Open a portfolio first.");
      if (type === "MARKET") return api.execute(accountId, symbol, side, n);
      const price = parseCents(limit)!;
      return api.placeOrder({ account_id: accountId, symbol, side, type, shares: n, ...(type === "LIMIT" ? { limit_cents: price } : { stop_cents: price }) });
    },
    onSuccess: (result) => {
      if ("price_cents" in result) markShown(result.id);
      setReceipt(result);
      setConfirming(false);
      setError(null);
      for (const queryKey of [["portfolio"], ["orders"], ["history"], ["chart", symbol], ["equity"]]) client.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      setConfirming(false);
      setError(e instanceof ApiError ? e.message : "The order couldn't be sent.");
    },
  });

  const verb = side === "BUY" ? "Buy" : "Sell";
  const problem =
    n < 1
      ? mode === "amount" ? "That amount doesn't buy a whole share." : "Enter at least 1 share."
      : type !== "MARKET" && !parseCents(limit)
        ? `Enter a ${type === "LIMIT" ? "limit" : "stop"} price.`
        : side === "SELL" && n > owned
          ? owned ? `You own ${fmtShares(owned)} ${symbol}.` : `You don't own any ${symbol}.`
          : side === "BUY" && est && portfolio && est.total > portfolio.buying_power_cents
            ? `That needs ${money(est.total)}; you have ${money(portfolio.buying_power_cents)} to spend.`
            : null;
  const label = `${verb} ${fmtShares(Math.max(n, 0))} ${symbol}${type === "MARKET" ? "" : ` ${type === "LIMIT" ? "limit" : "stop"} ${money(parseCents(limit))}`}`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || send.isPending) return;
    if (settings.confirm_orders && !confirming) return setConfirming(true);
    send.mutate();
  };

  const size = (fraction: number) => {
    setMode("shares");
    if (side === "SELL") return setQty(String(Math.floor(owned * fraction)));
    if (!priced || !portfolio) return;
    const unit = estimate("BUY", 1, priced, type !== "LIMIT", { ...settings, commission_cents: 0 }).total;
    setQty(String(Math.max(0, Math.floor((portfolio.buying_power_cents * fraction - settings.commission_cents) / unit))));
  };

  const closedNote =
    type === "MARKET" && !status.live
      ? settings.practice_mode
        ? "Market closed: Practice mode fills this now at the last price."
        : "Market closed: this order waits and fills at the next open."
      : null;

  return (
    <div>
      <form onSubmit={submit} className="paper overflow-hidden rounded-lg" aria-label="Order ticket">
        <div className="grid grid-cols-2" role="tablist" aria-label="Side">
          {(["BUY", "SELL"] as Side[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
              className={cx(
                "press h-10 text-[13px] font-semibold tracking-wide",
                side === s ? (s === "BUY" ? "bg-buy text-white" : "bg-sell text-white") : "bg-black/5 text-paper-ink/60 hover:text-paper-ink",
              )}
            >
              {s === "BUY" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <div className="grid gap-3 p-3.5">
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded-md bg-black/5 p-0.5" role="radiogroup" aria-label="Order type">
              {(["MARKET", "LIMIT", "STOP"] as OrderType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={type === t}
                  onClick={() => setType(t)}
                  className={cx("h-7 rounded-[5px] px-2.5 text-xs font-medium", type === t ? "bg-white text-paper-ink shadow-sm" : "text-paper-ink/60 hover:text-paper-ink")}
                >
                  {t === "MARKET" ? "Market" : t === "LIMIT" ? "Limit" : "Stop"}
                </button>
              ))}
            </div>
            <span className="num font-mono text-xs text-paper-ink/70">{ref ? money(ref) : "—"}</span>
          </div>

          <div className="grid gap-1">
            <div className="flex justify-between text-xs text-paper-ink/70">
              <button
                type="button"
                className="underline decoration-paper-rule underline-offset-2 hover:decoration-current"
                onClick={() => setMode(mode === "shares" ? "amount" : "shares")}
                title="Switch between a number of shares and a dollar amount"
              >
                {mode === "shares" ? "Shares" : "Amount in dollars"}
              </button>
              <span className="num">{side === "BUY" ? `Buying power ${money(portfolio?.buying_power_cents)}` : `You own ${fmtShares(owned)}`}</span>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              {mode === "shares" ? (
                <input className={paperInput} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} aria-label="Shares" />
              ) : (
                <input className={paperInput} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in dollars" />
              )}
              <div className="flex gap-1 pb-0.5">
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} type="button" onClick={() => size(f)} className="press h-8 rounded-md bg-black/5 px-2 text-xs font-medium text-paper-ink/80 hover:bg-black/10">
                  {f === 1 ? "Max" : `${f * 100}%`}
                </button>
              ))}
              </div>
            </div>
          </div>
          {mode === "amount" && <p className="-mt-2 text-xs text-paper-ink/70">= {fmtShares(n)} whole shares</p>}

          {type !== "MARKET" && (
            <label className="grid gap-1">
              <span className="text-xs text-paper-ink/70">
                {type === "LIMIT"
                  ? side === "BUY" ? "Buy at this price or lower" : "Sell at this price or higher"
                  : side === "BUY" ? "Buy once the price rises to" : "Sell once the price falls to"}
              </span>
              <input className={paperInput} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label={`${type === "LIMIT" ? "Limit" : "Stop"} price`} />
            </label>
          )}

          <dl className="grid gap-0.5 border-t border-dashed border-paper-rule pt-2.5 font-mono text-[12px]">
            <div className="flex justify-between"><dt>Price{type !== "LIMIT" && settings.slippage_bps ? " with slippage" : ""}</dt><dd className="num">{est ? money(est.price) : "—"}</dd></div>
            <div className="flex justify-between"><dt>Commission</dt><dd className="num">{est ? money(est.fee) : "—"}</dd></div>
            <div className="flex justify-between font-medium"><dt>Estimated {side === "BUY" ? "cost" : "proceeds"}</dt><dd className="num">{est ? money(est.total) : "—"}</dd></div>
          </dl>

          {closedNote && <p className="text-xs text-paper-ink/75">{closedNote}</p>}

          <button
            type="submit"
            disabled={!!problem || send.isPending}
            className={cx(
              "press h-10 rounded-md text-[13px] font-semibold text-white disabled:opacity-45",
              side === "BUY" ? "bg-buy" : "bg-sell",
              confirming && "ring-2 ring-offset-2 ring-offset-[var(--paper)]",
            )}
          >
            {send.isPending ? "Sending…" : confirming ? `Confirm: ${label}` : label}
          </button>
          {confirming && (
            <button type="button" onClick={() => setConfirming(false)} className="-mt-1 text-xs text-paper-ink/70 hover:text-paper-ink">
              Not now
            </button>
          )}
          {(error ?? problem) && <p className={cx("text-xs", error ? "text-[#b8352a]" : "text-paper-ink/70")}>{error ?? problem}</p>}
        </div>
      </form>
      {receipt && <Receipt key={"price_cents" in receipt ? `t${receipt.id}` : `o${receipt.id}`} receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}
