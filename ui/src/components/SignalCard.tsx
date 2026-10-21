import { useQuery } from "@tanstack/react-query";
import { CircleHelp, LoaderCircle } from "lucide-react";

import { useDesk } from "../desk";
import { api, type SignalReport } from "../lib/api";
import { edgeRange, marketDay, percent } from "../lib/format";
import { cx, Tip } from "./ui";

const tone = { BUY: "text-up", SELL: "text-down", HOLD: "text-ink" } as const;
const word = { BUY: "Buy", SELL: "Sell", HOLD: "Hold" } as const;

function Probabilities({ s }: { s: SignalReport }) {
  // diverging: sell and buy at the ends, hold as the neutral middle
  const parts = [
    { label: "Sell", value: s.p_sell, color: "var(--down)" },
    { label: "Hold", value: s.p_hold, color: "var(--rule)" },
    { label: "Buy", value: s.p_buy, color: "var(--up)" },
  ];
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label} ${percent(p.value, { digits: 0 })}`).join(", ")}>
        {parts.map((p) => (
          <span key={p.label} style={{ width: `${p.value * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-3 text-[11px] text-ink-2">
        {parts.map((p, i) => (
          <span key={p.label} className={cx("num", i === 1 && "text-center", i === 2 && "text-right")}>
            {p.label} {percent(p.value, { digits: 0 })}
          </span>
        ))}
      </div>
    </div>
  );
}

function verdictLine(s: SignalReport) {
  const { scores, verdict, edge_range, tries } = s.model.summary;
  const best = Math.max(scores.majority.balanced_accuracy, scores.always_buy.balanced_accuracy, scores.yesterday.balanced_accuracy);
  const range = edge_range ? ` (an edge ${edgeRange(edge_range, tries)})` : "";
  const d = s.model.summary.direction;
  // the three-way score mostly comes from telling flat days from moves, so say how up against down alone did
  const alone = d?.n ? ` Up or down alone, on days that moved, it was right ${percent(d.right / d.n, { digits: 0 })} of the time.` : "";
  return `Out of sample this model is ${verdict}: balanced accuracy ${percent(scores.model.balanced_accuracy, { digits: 1 })} against ${percent(best, { digits: 1 })} for the best simple rule${range}.${alone}`;
}

/** The reading with real skill: not which way, but whether the next bar moves more than usual */
function Move({ m, interval }: { m: NonNullable<SignalReport["move"]>; interval: "1d" | "1h" }) {
  const bigger = m.call === "BIG";
  const what = bigger ? "Bigger move than usual" : "Quieter than usual";
  const bar = interval === "1h" ? "hour" : "day";
  return (
    <div className="grid gap-1 border-t border-rule pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx("font-semibold", m.clear ? "text-ink" : "text-ink-2")}>
          {m.clear ? what : "No clear move call"}
        </span>
        <span className="text-ink-2">
          {!m.clear && <>leans {bigger ? "bigger" : "quieter"}, </>}
          <span className="num font-medium text-ink">{percent(m.confidence, { digits: 0 })}</span> sure
        </span>
      </div>
      <p className="text-[12px] leading-snug text-ink-2">
        Usual is a {percent(m.usual, { digits: 1 })} move, the median of the last 60 {bar}s; up or down doesn&rsquo;t matter here.{" "}
        {m.band
          ? `When it said ${bigger ? "bigger" : "quieter"} this sure before, it was right ${m.band.right} of ${m.band.n} times (${percent(m.band.right / m.band.n, { digits: 0 })}), against ${percent(m.base_rate, { digits: 0 })} by chance.`
          : "It hasn't made this call at this confidence out of sample yet."}
        {m.live_record.n ? ` Live: ${m.live_record.right} of ${m.live_record.n} right.` : ""}
      </p>
    </div>
  );
}

export function SignalCard() {
  const { symbol, chart, setView } = useDesk();
  const interval = chart.interval === "1h" ? "1h" : "1d";
  const { data: s, isLoading, error } = useQuery({
    queryKey: ["signal", symbol, interval],
    queryFn: () => api.signal(symbol, interval),
    staleTime: 60_000,
    retry: false,
  });

  return (
    <section aria-labelledby="signal-title" className="mt-3 rounded-lg border border-rule bg-raised p-3.5">
      <header className="flex items-center justify-between">
        <h2 id="signal-title" className="text-[13px] font-semibold">
          Model signal <span className="font-normal text-ink-2">for the next {interval === "1h" ? "hour" : "day"}</span>
        </h2>
        <Tip text="The model reads RSI, the EMA spread, volume and the Bollinger position, and guesses whether the next bar closes more than the threshold up (buy), down (sell) or in between (hold). It is tested only on data it never trained on.">
          <button type="button" aria-label="How the signal works" className="text-ink-3 hover:text-ink">
            <CircleHelp className="size-4" />
          </button>
        </Tip>
      </header>

      {isLoading && (
        <p className="mt-3 flex items-center gap-2 text-ink-2">
          <LoaderCircle className="size-4 animate-spin" /> Training on {symbol}&rsquo;s history. The first time takes up to half a minute.
        </p>
      )}
      {error && <p className="mt-3 text-ink-2">{error.message}</p>}
      {s && (
        <div className="mt-2 grid gap-3">
          {s.clear ? (
            <div className="flex items-baseline justify-between">
              <span className={cx("text-2xl font-semibold", tone[s.signal])}>{word[s.signal]}</span>
              <span className="text-ink-2">
                <span className="num font-medium text-ink">{percent(s.confidence, { digits: 0 })}</span> sure, after {marketDay(s.ts)}
              </span>
            </div>
          ) : (
            <div>
              <span className="text-xl font-semibold text-ink-2">No clear edge</span>
              <p className="text-ink-2">
                Leans <span className={cx("font-medium", tone[s.signal])}>{word[s.signal].toLowerCase()}</span>,{" "}
                <span className="num font-medium text-ink">{percent(s.confidence, { digits: 0 })}</span> sure, after {marketDay(s.ts)}
              </p>
            </div>
          )}
          <Probabilities s={s} />
          <p className="text-[12px] leading-snug text-ink-2">
            {s.moved?.n
              ? `When it said ${s.signal.toLowerCase()} this sure before, ${s.moved.n} of those days moved more than ${percent(s.model.threshold, { digits: 1 })}, and it had the direction right on ${s.moved.right} (${percent(s.moved.right / s.moved.n, { digits: 0 })}). A coin toss is 50%.`
              : s.band
                ? `When it said ${s.signal.toLowerCase()} this sure before, it was right ${s.band.right} of ${s.band.n} times (${percent(s.band.right / s.band.n, { digits: 0 })}). A ${s.signal.toLowerCase()} day came ${percent(s.base_rate, { digits: 0 })} of the time anyway.`
                : "It hasn't made this call at this confidence out of sample yet."}{" "}
            {verdictLine(s)}
          </p>
          {s.move && <Move m={s.move} interval={interval} />}
          <p className="text-[12px] text-ink-2">
            Live record:{" "}
            {s.live_record.n ? (
              <span className="num text-ink">
                {s.live_record.right} of {s.live_record.n} right
              </span>
            ) : (
              "starts once the next bar closes."
            )}
          </p>
          <dl className="grid grid-cols-5 gap-1 border-t border-rule pt-2 text-center text-[11px]">
            {[
              ["RSI", s.indicators.rsi.toFixed(0)],
              ["EMA gap", percent(s.indicators.ema_spread, { sign: true, digits: 1 })],
              ["Volume z", s.indicators.vol_z.toFixed(1)],
              ["%B", s.indicators.pct_b.toFixed(2)],
              ["Band", percent(s.indicators.bb_width, { digits: 1 })],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-ink-3">{k}</dt>
                <dd className="num text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center justify-between text-[11px] text-ink-3">
            <span>Educational, not financial advice.</span>
            <button type="button" className="text-buy hover:underline" onClick={() => setView("lab")}>
              Open Model lab
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
