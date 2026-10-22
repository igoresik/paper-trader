import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LineChart } from "../components/LineChart";
import { Button, cx, Empty, NumberInput, Segmented, Select, Switch } from "../components/ui";
import { useDesk } from "../desk";
import { api, type Band, type Run, type RunParams } from "../lib/api";
import { dateTime, edgeRange, marketDay, percent, points } from "../lib/format";
import { onJob } from "../lib/live";

const DEFAULTS: RunParams = {
  interval: "1d",
  threshold: 0.005,
  estimator: "random_forest",
  trees: 200,
  max_depth: 3,
  learning_rate: 0.05,
  min_leaf: 20,
  folds: 5,
  min_confidence: 0,
  cost_bps: 5,
  prune: false,
  horizon: 1,
  indicators: { rsi: 14, ema_fast: 12, ema_slow: 26, bb: 20, bb_k: 2, vol: 20, context: true, regime: true },
};
const FEATURE_NAMES: Record<string, string> = {
  rsi: "RSI", ema_spread: "EMA gap", vol_z: "Volume z-score", pct_b: "Bollinger %B", bb_width: "Band width",
  ret_5: "5-day move", ret_20: "20-day move", vix: "VIX", vix_change: "VIX, 5-day change", yield_change: "Yield, 5-day change",
  vol_ratio: "Volatility, 5 vs 60 days", ret_z: "Move in volatility units", ret_5_z: "5-day move in volatility units",
};
const pct = (v: number, digits = 1) => percent(v, { digits });

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1" title={hint}>
      <span className="text-ink-2">{label}</span>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-rule pt-2">
      <legend className="pr-2 text-[12px] font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Form({ params, set }: { params: RunParams; set: (p: RunParams) => void }) {
  const ind = (key: keyof RunParams["indicators"], v: number) => set({ ...params, indicators: { ...params.indicators, [key]: v } });
  return (
    <div className="grid gap-3">
      <Group title="What it predicts">
        <Setting label="Bars">
          <Segmented size="sm" label="Bar interval" value={params.interval} onChange={(interval) => set({ ...params, interval, threshold: interval === "1d" ? 0.005 : 0.002 })} options={[{ value: "1d", label: "Daily" }, { value: "1h", label: "Hourly" }]} />
        </Setting>
        <Setting label="Call">
          <Segmented size="sm" label="What the call is about" value={(params.horizon ?? 1) > 1 ? "barrier" : "next"} onChange={(v) => set({ ...params, horizon: v === "barrier" ? 5 : 1 })} options={[{ value: "next", label: "Next bar" }, { value: "barrier", label: "First barrier" }]} />
        </Setting>
        {(params.horizon ?? 1) > 1 ? (
          <Setting label="Bars ahead" hint="BUY if the close rises by the barrier before it falls by it within this many bars, SELL the other way, HOLD if it reaches neither. The barrier is the last 20 bars' volatility stretched to this many bars.">
            <NumberInput label="Bars ahead" value={params.horizon!} min={2} max={20} onCommit={(horizon) => set({ ...params, horizon })} />
          </Setting>
        ) : (
          <Setting label="Move that counts (%)" hint="Next-bar change beyond this is BUY or SELL; anything smaller is HOLD.">
            <NumberInput label="Move that counts" value={+(params.threshold * 100).toFixed(2)} min={0.05} max={5} step={0.05} onCommit={(v) => set({ ...params, threshold: v / 100 })} />
          </Setting>
        )}
      </Group>
      <Group title="Model">
        <Setting label="Kind">
          <Segmented size="sm" label="Model kind" value={params.estimator} onChange={(estimator) => set({ ...params, estimator })} options={[{ value: "random_forest", label: "Random forest" }, { value: "gradient_boosting", label: "Boosting" }]} />
        </Setting>
        <Setting label={params.estimator === "random_forest" ? "Trees" : "Boosting rounds"}>
          <NumberInput label="Trees" value={params.trees} min={10} max={1000} onCommit={(trees) => set({ ...params, trees })} />
        </Setting>
        <Setting label="Max depth" hint="Shallow trees overfit less.">
          <NumberInput label="Max depth" value={params.max_depth} min={1} max={20} onCommit={(max_depth) => set({ ...params, max_depth })} />
        </Setting>
        <Setting label="Min bars per leaf">
          <NumberInput label="Minimum bars per leaf" value={params.min_leaf} min={1} max={500} onCommit={(min_leaf) => set({ ...params, min_leaf })} />
        </Setting>
        {params.estimator === "gradient_boosting" && (
          <Setting label="Learning rate">
            <NumberInput label="Learning rate" value={params.learning_rate} min={0.001} max={1} step={0.01} onCommit={(learning_rate) => set({ ...params, learning_rate })} />
          </Setting>
        )}
        <Setting label="Min confidence" hint="Below this, the call becomes HOLD.">
          <NumberInput label="Minimum confidence" value={params.min_confidence} min={0} max={0.95} step={0.01} onCommit={(min_confidence) => set({ ...params, min_confidence })} />
        </Setting>
        <Switch
          checked={params.prune ?? false}
          onChange={(prune) => set({ ...params, prune })}
          label="Drop inputs that don't help, picked inside each training window"
        />
      </Group>
      <Group title="Indicators">
        <Setting label="RSI period"><NumberInput label="RSI period" value={params.indicators.rsi} min={2} max={100} onCommit={(v) => ind("rsi", v)} /></Setting>
        <Setting label="EMA fast / slow">
          <span className="flex gap-1">
            <NumberInput label="Fast EMA" value={params.indicators.ema_fast} min={2} max={200} onCommit={(v) => ind("ema_fast", v)} />
            <NumberInput label="Slow EMA" value={params.indicators.ema_slow} min={3} max={400} onCommit={(v) => ind("ema_slow", v)} />
          </span>
        </Setting>
        <Setting label="Bollinger period / width">
          <span className="flex gap-1">
            <NumberInput label="Bollinger period" value={params.indicators.bb} min={2} max={200} onCommit={(v) => ind("bb", v)} />
            <NumberInput label="Bollinger width" value={params.indicators.bb_k} min={0.5} max={5} step={0.1} onCommit={(v) => ind("bb_k", v)} />
          </span>
        </Setting>
        <Setting label="Volume window"><NumberInput label="Volume window" value={params.indicators.vol} min={2} max={200} onCommit={(v) => ind("vol", v)} /></Setting>
        <Switch
          checked={params.indicators.context ?? false}
          onChange={(context) => set({ ...params, indicators: { ...params.indicators, context } })}
          label="Market context: VIX, 10-year yield, 5- and 20-day moves"
        />
        <Switch
          checked={params.indicators.regime ?? false}
          onChange={(regime) => set({ ...params, indicators: { ...params.indicators, regime } })}
          label="Volatility regime: recent swings against the usual, and moves measured in them"
        />
      </Group>
      <Group title="Test">
        <Setting label="Walk-forward folds"><NumberInput label="Folds" value={params.folds} min={2} max={10} onCommit={(folds) => set({ ...params, folds })} /></Setting>
        <Setting label="Cost per trade (bps)" hint="Charged on every change of position in the backtest; 1 bps is 0.01%.">
          <NumberInput label="Cost per trade" value={params.cost_bps} min={0} max={500} step={0.5} onCommit={(cost_bps) => set({ ...params, cost_bps })} />
        </Setting>
      </Group>
    </div>
  );
}

function Confusion({ m }: { m: number[][] }) {
  const max = Math.max(1, ...m.flat());
  const names = ["Sell", "Hold", "Buy"];
  return (
    <table className="text-center text-[12px]">
      <caption className="mb-1 text-left text-[12px] text-ink-2">Rows: what happened. Columns: what the model said.</caption>
      <thead>
        <tr>
          <th />
          {names.map((n) => <th key={n} className="px-2 pb-1 font-medium text-ink-2">{n}</th>)}
        </tr>
      </thead>
      <tbody>
        {m.map((row, i) => (
          <tr key={names[i]}>
            <th className="pr-2 text-right font-medium text-ink-2">{names[i]}</th>
            {row.map((count, j) => (
              <td key={j} className="num size-14 border-2 border-panel font-medium" style={{ background: `color-mix(in srgb, var(--ma2) ${Math.round((count / max) * 70)}%, transparent)` }}>
                {count}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Importance({ values, dropped }: { values: Record<string, number>; dropped: string[] }) {
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const top = Math.max(0.0001, ...rows.map(([, v]) => v));
  return (
    <div className="grid gap-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[110px_1fr_52px] items-center gap-2 text-[12px]">
          <span className="text-ink-2">{FEATURE_NAMES[k] ?? k}</span>
          <span className="h-2 rounded-full bg-rule/60">
            <span className="block h-2 rounded-full bg-[var(--ma2)]" style={{ width: `${Math.max(0, v / top) * 100}%` }} />
          </span>
          <span className="num text-right">{v.toFixed(3)}</span>
        </div>
      ))}
      <p className="text-[11px] text-ink-3">How much balanced accuracy drops on the last test block when the feature is shuffled. Near zero or below: the model doesn&rsquo;t really use it.</p>
      {dropped.length > 0 && <p className="text-[11px] text-ink-3">Dropped for the last block: {dropped.map((k) => FEATURE_NAMES[k] ?? k).join(", ")}.</p>}
    </div>
  );
}

function Record({ bands }: { bands: Band[] }) {
  return (
    <table className="w-full text-[12px]">
      <thead className="text-ink-3">
        <tr className="[&>th]:py-1 [&>th]:font-medium">
          <th className="text-left">Call</th><th className="text-left">Confidence</th><th className="text-right">Calls</th><th className="text-right">Right</th>
        </tr>
      </thead>
      <tbody>
        {bands.map((b) => (
          <tr key={`${b.signal}${b.from}`} className="num border-t border-rule [&>td]:py-1">
            <td className={b.signal === "BUY" ? "text-up" : b.signal === "SELL" ? "text-down" : ""}>{b.signal.toLowerCase()}</td>
            <td>{pct(b.from, 0)} to {pct(b.to, 0)}</td>
            <td className="text-right">{b.n}</td>
            <td className="text-right">{pct(b.right / b.n, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ run, onActivate, activating }: { run: Run; onActivate: () => void; activating: boolean }) {
  const { theme } = useDesk();
  const m = run.metrics;
  const s = m.summary.scores;
  const best = Math.max(s.majority.balanced_accuracy, s.always_buy.balanced_accuracy, s.yesterday.balanced_accuracy);
  const bt = m.backtest;
  const curve = bt.curve;
  // one strategy at a time, each next to holding its own average size, so the chart stays readable
  const [pick, setPick] = useState<"calls" | "lean" | "calm">("calls");
  const views = [
    { value: "calls" as const, label: "Its calls" },
    ...(bt.sized && bt.steady && curve?.sized && curve.steady ? [{ value: "lean" as const, label: "Sized by its lean" }] : []),
    ...(bt.calm && bt.calm_steady && curve?.calm && curve.calm_steady ? [{ value: "calm" as const, label: "Calm before big moves" }] : []),
  ];
  const view = views.some((v) => v.value === pick) ? pick : "calls";
  const lines = useMemo(() => {
    if (!curve) return [];
    const hold = { label: "Buy and hold", color: "--ink-3", values: curve.buy_hold };
    if (view === "lean") return [{ label: "Sized by its lean", color: "--ma2", values: curve.sized! }, { label: "Same size, always", color: "--ma1", values: curve.steady! }, hold];
    if (view === "calm") return [{ label: "Calm before big moves", color: "--osc", values: curve.calm! }, { label: "Same size, always", color: "--ma1", values: curve.calm_steady! }, hold];
    return [{ label: "Follow the model", color: "--buy", values: curve.strategy }, hold];
  }, [curve, view]);
  const [mine, base, against] =
    view === "lean" ? [bt.sized!, bt.steady!, "the same size"] : view === "calm" ? [bt.calm!, bt.calm_steady!, "the same size"] : [bt.strategy, bt.buy_hold, "buy and hold"];
  const overfit = (m.folds ?? []).some((f) => f.train_balanced_accuracy - f.balanced_accuracy > 0.15);
  const kept = run.params.prune ? m.folds?.at(-1)?.inputs : undefined;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">
            {run.symbol}, {run.interval === "1d" ? "daily" : "hourly"} bars, {run.params.estimator === "random_forest" ? "random forest" : "gradient boosting"}
            {(run.params.horizon ?? 1) > 1 ? `, first barrier within ${run.params.horizon} bars` : ""}
          </h2>
          <p className="text-ink-2">Run {run.id}, {dateTime(run.created_at)}, tested on {m.rows} bars{m.from ? ` from ${marketDay(m.from)} to ${marketDay(m.to!)}` : ""}</p>
        </div>
        {run.active ? (
          <span className="rounded-md bg-buy/12 px-2.5 py-1 text-[12px] font-medium text-buy">Drives the live signal</span>
        ) : (
          <Button tone="buy" onClick={onActivate} disabled={activating}>Use for live signals</Button>
        )}
      </div>

      <div className="grid gap-2 text-[14px] leading-snug">
        <p>
          <b className="font-semibold">Up, flat or down:</b> {m.summary.verdict}. Balanced accuracy {pct(s.model.balanced_accuracy)} against {pct(best)} for the best simple rule ({points(m.summary.edge)} points{m.summary.edge_range ? `, ${edgeRange(m.summary.edge_range, m.summary.tries)}` : ""}), and {pct(m.summary.fold_balanced_accuracy.mean)} &plusmn; {pct(m.summary.fold_balanced_accuracy.std)} across the folds.
        </p>
        {m.summary.direction && m.summary.direction.n > 0 && (
          <p>
            <b className="font-semibold">Up or down alone:</b> {(run.params.horizon ?? 1) > 1 ? "when a barrier was reached" : "on days that moved"}, when it called a direction it was right{" "}
            {pct(m.summary.direction.right / m.summary.direction.n)} of {m.summary.direction.n} times
            {m.summary.direction.range ? ` (likely ${pct(m.summary.direction.range[0])} to ${pct(m.summary.direction.range[1])})` : ""}. A coin toss is 50%.
          </p>
        )}
        {m.move && (
          <p>
            <b className="font-semibold">Move size calls:</b> {m.move.summary.verdict}. Calling whether the next bar moves more than usual, balanced accuracy{" "}
            {pct(m.move.summary.scores.model.balanced_accuracy)} against{" "}
            {pct(Math.max(m.move.summary.scores.majority.balanced_accuracy, m.move.summary.scores.always_buy.balanced_accuracy, m.move.summary.scores.yesterday.balanced_accuracy))}{" "}
            for the best simple rule ({points(m.move.summary.edge)} points{m.move.summary.edge_range ? `, ${edgeRange(m.move.summary.edge_range, m.move.summary.tries)}` : ""}).
          </p>
        )}
        <p>
          <b className="font-semibold">As a strategy:</b> buying on its calls returned {percent(bt.strategy.total_return, { sign: true, digits: 1 })} against {percent(bt.buy_hold.total_return, { sign: true, digits: 1 })} for buy and hold over the same days, after {run.params.cost_bps} bps per trade.
        </p>
        {bt.sized && bt.steady && bt.sized_exposure != null && (
          <p>
            <b className="font-semibold">Sized by its lean:</b> holding between half and all of the money, more when it leaned up harder than usual, returned{" "}
            {percent(bt.sized.total_return, { sign: true, digits: 1 })} (Sharpe {bt.sized.sharpe.toFixed(2)}) against{" "}
            {percent(bt.steady.total_return, { sign: true, digits: 1 })} (Sharpe {bt.steady.sharpe.toFixed(2)}) for holding its average {pct(bt.sized_exposure, 0)} all the time. The gap between the two is what sizing adds beyond being in the market.
          </p>
        )}
        {bt.calm && bt.calm_steady && bt.calm_exposure != null && (
          <p>
            <b className="font-semibold">Calm before big moves:</b> holding between half and all of the money, less when the move reading saw a bigger move than usual coming, returned{" "}
            {percent(bt.calm.total_return, { sign: true, digits: 1 })} (Sharpe {bt.calm.sharpe.toFixed(2)}, worst drop {pct(bt.calm.max_drawdown)}) against{" "}
            {percent(bt.calm_steady.total_return, { sign: true, digits: 1 })} (Sharpe {bt.calm_steady.sharpe.toFixed(2)}, worst drop {pct(bt.calm_steady.max_drawdown)}) for holding its average {pct(bt.calm_exposure, 0)} all the time. Big moves go both ways, so stepping back before them only helps if they are more often falls.
          </p>
        )}
        {overfit && (
          <p className="flex items-start gap-1.5 text-[13px] text-warn">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> It scores much better on its training data than on new data: it is memorising. Try shallower trees or more bars per leaf.
          </p>
        )}
      </div>

      {curve && (
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">Growth of $100, out of sample</h3>
            {views.length > 1 && <Segmented size="sm" label="Strategy" value={view} onChange={setPick} options={views} />}
          </div>
          <LineChart t={curve.t} lines={lines} theme={theme} height={220} />
          <div className="mt-2 grid grid-cols-2 gap-x-8 text-[12px] text-ink-2 sm:grid-cols-4">
            <span>Sharpe <b className="num text-ink">{mine.sharpe.toFixed(2)}</b> vs <b className="num text-ink">{base.sharpe.toFixed(2)}</b> for {against}</span>
            <span>Worst drop <b className="num text-ink">{pct(mine.max_drawdown)}</b> vs <b className="num text-ink">{pct(base.max_drawdown)}</b></span>
            {view === "calls" ? (
              <>
                <span>In the market <b className="num text-ink">{pct(bt.exposure, 0)}</b> of the time</span>
                <span><b className="num text-ink">{bt.trades}</b> trades{bt.hit_rate != null ? <>, <b className="num text-ink">{pct(bt.hit_rate, 0)}</b> of buy days went up</> : null}</span>
              </>
            ) : (
              <span>Holds <b className="num text-ink">{pct((view === "lean" ? bt.sized_exposure : bt.calm_exposure) ?? 0, 0)}</b> of the money on average</span>
            )}
          </div>
        </section>
      )}

      {m.folds && (
        <section>
          <h3 className="mb-1 text-[13px] font-semibold">Each test block</h3>
          <p className="mb-2 text-[12px] text-ink-2">Trained on everything before the block, tested on the block, then rolled forward. Baselines are scored on the same bars.</p>
          <table className="w-full text-right text-[12px]">
            <thead className="text-ink-3">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-medium">
                <th className="text-left">Tested</th><th>Accuracy</th><th>Balanced</th><th>Macro F1</th><th>Majority</th><th>Always buy</th><th>Yesterday</th><th>On its training data</th>{kept && <th>Inputs kept</th>}
              </tr>
            </thead>
            <tbody>
              {m.folds.map((f) => (
                <tr key={f.fold} className="num border-t border-rule [&>td]:px-2 [&>td]:py-1">
                  <td className="text-left">{marketDay(f.test_from)} to {marketDay(f.test_to)}</td>
                  <td>{pct(f.accuracy)}</td>
                  <td className="font-medium">{pct(f.balanced_accuracy)}</td>
                  <td>{pct(f.macro_f1)}</td>
                  <td>{pct(f.baselines.majority)}</td>
                  <td>{pct(f.baselines.always_buy)}</td>
                  <td>{pct(f.baselines.yesterday)}</td>
                  <td className={cx(f.train_balanced_accuracy - f.balanced_accuracy > 0.15 && "text-warn")}>{pct(f.train_balanced_accuracy)}</td>
                  {kept && <td title={f.inputs!.map((k) => FEATURE_NAMES[k] ?? k).join(", ")}>{f.inputs!.length} of {m.inputs?.length}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-3">
        {m.confusion && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">Calls against outcomes</h3>
            <Confusion m={m.confusion} />
          </section>
        )}
        {m.importance && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">What it leans on</h3>
            <Importance values={m.importance} dropped={kept ? (m.inputs ?? []).filter((k) => !kept.includes(k)) : []} />
          </section>
        )}
        {m.track_record && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">Right, by confidence</h3>
            <Record bands={m.track_record} />
          </section>
        )}
      </div>
    </div>
  );
}

export function ModelLab() {
  const { symbol, setSymbol, settings, save } = useDesk();
  const client = useQueryClient();
  const { data: watchlist = [] } = useQuery({ queryKey: ["watchlist"], queryFn: api.watchlist });
  const [params, setParams] = useState<RunParams>(() => {
    const { symbol: _ignored, ...saved } = settings.lab;
    return { ...DEFAULTS, ...saved, indicators: { ...DEFAULTS.indicators, ...saved.indicators } };
  });
  const [chosen, setChosen] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const runs = useQuery({ queryKey: ["runs", symbol, params.interval], queryFn: () => api.runs(symbol, params.interval) });
  const shownId = chosen ?? runs.data?.find((r) => r.active)?.id ?? runs.data?.[0]?.id ?? null;
  const run = useQuery({ queryKey: ["run", shownId], queryFn: () => api.run(shownId!), enabled: shownId != null });
  const testing = useRef<string | null>(null); // the symbol under test; progress events can arrive after the reply
  const onScreen = useRef(symbol);
  useEffect(() => {
    onScreen.current = symbol;
  }, [symbol]);
  useEffect(() => onJob((s, p) => s === testing.current && s === onScreen.current && setProgress(p)), []);
  useEffect(() => setChosen(null), [symbol, params.interval]);

  const start = useMutation({
    mutationFn: () => api.newRun(symbol, params),
    onMutate: () => {
      testing.current = symbol;
      setProgress(0);
    },
    onSuccess: (r) => {
      client.setQueryData(["run", r.id], r);
      client.invalidateQueries({ queryKey: ["runs", r.symbol] });
      if (r.symbol === onScreen.current) setChosen(r.id);
      save({ lab: { ...r.params, symbol: r.symbol } });
    },
    onError: (e) => toast.error("The test couldn't run", { description: e.message }),
    onSettled: () => {
      testing.current = null;
      setProgress(null);
    },
  });
  const activate = useMutation({
    mutationFn: api.activate,
    onSuccess: (r) => {
      for (const queryKey of [["runs", r.symbol], ["run", r.id], ["signal", r.symbol], ["chart", r.symbol], ["watchlist"]]) client.invalidateQueries({ queryKey });
      toast.success(`Live signals for ${r.symbol} now come from run ${r.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const symbols = [...new Set([symbol, ...watchlist.map((w) => w.symbol)])];
  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-r border-rule bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-[15px] font-semibold">Model lab</h1>
          <Select label="Symbol" value={symbol} onChange={setSymbol} options={symbols.map((s) => ({ value: s, label: s }))} />
        </div>
        <p className="mb-3 text-[12px] text-ink-2">Change the settings and test them the honest way: the model is always scored on bars it never trained on.</p>
        <Form params={params} set={setParams} />
        <div className="mt-4 grid gap-2">
          <Button tone="buy" className="h-9" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? <><LoaderCircle className="size-4 animate-spin" /> Testing&hellip;</> : "Run walk-forward test"}
          </Button>
          {progress != null && (
            <div className="h-1 overflow-hidden rounded-full bg-rule" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div className="h-1 bg-buy transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <button type="button" className="text-[12px] text-ink-2 hover:text-ink" onClick={() => setParams(DEFAULTS)}>Back to the default settings</button>
        </div>
      </aside>
      <section className="min-h-0 overflow-auto p-5">
        {run.data ? (
          <Result run={run.data} onActivate={() => activate.mutate(run.data.id)} activating={activate.isPending} />
        ) : runs.isLoading || run.isLoading ? null : (
          <Empty title={`No tests for ${symbol} yet`}>Run one on the left. It takes 10 to 30 seconds on daily bars.</Empty>
        )}
        {!!runs.data?.length && (
          <section className="mt-8">
            <h3 className="mb-2 text-[13px] font-semibold">Earlier runs</h3>
            <table className="w-full text-[12px]">
              <thead className="text-ink-3">
                <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th]:font-medium">
                  <th className="!text-left">Run</th><th className="!text-left">Model</th><th>Move</th><th>Balanced</th><th>Edge</th><th>Strategy</th><th>Buy and hold</th><th />
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} onClick={() => setChosen(r.id)} className={cx("num cursor-pointer border-t border-rule text-right hover:bg-raised [&>td]:px-2 [&>td]:py-1", r.id === shownId && "bg-raised")}>
                    <td className="text-left">{r.id} <span className="text-ink-3">{dateTime(r.created_at)}</span></td>
                    <td className="text-left">{r.params.estimator === "random_forest" ? `Forest, ${r.params.trees} trees, depth ${r.params.max_depth}` : `Boosting, ${r.params.trees} rounds`}{r.params.prune ? ", pruned" : ""}</td>
                    <td>{(r.params.horizon ?? 1) > 1 ? `${r.params.horizon}-bar barrier` : pct(r.params.threshold, 2)}</td>
                    <td>{pct(r.metrics.summary.scores.model.balanced_accuracy)}</td>
                    <td>{points(r.metrics.summary.edge)}</td>
                    <td>{percent(r.metrics.backtest.strategy.total_return, { sign: true, digits: 1 })}</td>
                    <td>{percent(r.metrics.backtest.buy_hold.total_return, { sign: true, digits: 1 })}</td>
                    <td className="text-buy">{r.active ? "live" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </section>
    </div>
  );
}
