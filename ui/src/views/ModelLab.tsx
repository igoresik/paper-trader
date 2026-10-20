import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { LineChart } from "../components/LineChart";
import { Button, cx, Empty, NumberInput, Segmented, Select } from "../components/ui";
import { useDesk } from "../desk";
import { api, type Band, type Run, type RunParams } from "../lib/api";
import { dateTime, marketDay, percent } from "../lib/format";
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
  indicators: { rsi: 14, ema_fast: 12, ema_slow: 26, bb: 20, bb_k: 2, vol: 20 },
};
const FEATURE_NAMES: Record<string, string> = { rsi: "RSI", ema_spread: "EMA gap", vol_z: "Volume z-score", pct_b: "Bollinger %B", bb_width: "Band width" };
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
        <Setting label="Move that counts (%)" hint="Next-bar change beyond this is BUY or SELL; anything smaller is HOLD.">
          <NumberInput label="Move that counts" value={+(params.threshold * 100).toFixed(2)} min={0.05} max={5} step={0.05} onCommit={(v) => set({ ...params, threshold: v / 100 })} />
        </Setting>
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

function Importance({ values }: { values: Record<string, number> }) {
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
  const lines = useMemo(() => (curve ? [
    { label: "Follow the model", color: "--buy", values: curve.strategy },
    { label: "Buy and hold", color: "--ink-3", values: curve.buy_hold },
  ] : []), [curve]);
  const overfit = (m.folds ?? []).some((f) => f.train_balanced_accuracy - f.balanced_accuracy > 0.15);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">
            {run.symbol}, {run.interval === "1d" ? "daily" : "hourly"} bars, {run.params.estimator === "random_forest" ? "random forest" : "gradient boosting"}
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
          <b className="font-semibold">Direction calls:</b> {m.summary.verdict}. Balanced accuracy {pct(s.model.balanced_accuracy)} against {pct(best)} for the best simple rule ({m.summary.edge >= 0 ? "+" : ""}{(m.summary.edge * 100).toFixed(1)} points), and {pct(m.summary.fold_balanced_accuracy.mean)} &plusmn; {pct(m.summary.fold_balanced_accuracy.std)} across the folds.
        </p>
        <p>
          <b className="font-semibold">As a strategy:</b> buying on its calls returned {percent(bt.strategy.total_return, { sign: true, digits: 1 })} against {percent(bt.buy_hold.total_return, { sign: true, digits: 1 })} for buy and hold over the same days, after {run.params.cost_bps} bps per trade.
        </p>
        {overfit && (
          <p className="flex items-start gap-1.5 text-[13px] text-warn">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> It scores much better on its training data than on new data: it is memorising. Try shallower trees or more bars per leaf.
          </p>
        )}
      </div>

      {curve && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Growth of $100, out of sample</h3>
          <LineChart t={curve.t} lines={lines} theme={theme} height={220} />
          <div className="mt-2 grid grid-cols-2 gap-x-8 text-[12px] text-ink-2 sm:grid-cols-4">
            <span>Sharpe <b className="num text-ink">{bt.strategy.sharpe.toFixed(2)}</b> vs <b className="num text-ink">{bt.buy_hold.sharpe.toFixed(2)}</b></span>
            <span>Worst drop <b className="num text-ink">{pct(bt.strategy.max_drawdown)}</b> vs <b className="num text-ink">{pct(bt.buy_hold.max_drawdown)}</b></span>
            <span>In the market <b className="num text-ink">{pct(bt.exposure, 0)}</b> of the time</span>
            <span><b className="num text-ink">{bt.trades}</b> trades{bt.hit_rate != null ? <>, <b className="num text-ink">{pct(bt.hit_rate, 0)}</b> of buy days went up</> : null}</span>
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
                <th className="text-left">Tested</th><th>Accuracy</th><th>Balanced</th><th>Macro F1</th><th>Majority</th><th>Always buy</th><th>Yesterday</th><th>On its training data</th>
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
            <Importance values={m.importance} />
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
  useEffect(() => onJob((s, p) => s === symbol && setProgress(p)), [symbol]);
  useEffect(() => setChosen(null), [symbol, params.interval]);

  const start = useMutation({
    mutationFn: () => api.newRun(symbol, params),
    onMutate: () => setProgress(0),
    onSuccess: (r) => {
      client.setQueryData(["run", r.id], r);
      client.invalidateQueries({ queryKey: ["runs", symbol] });
      setChosen(r.id);
      save({ lab: { ...params, symbol } });
    },
    onError: (e) => toast.error("The test couldn't run", { description: e.message }),
    onSettled: () => setProgress(null),
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
          <Empty title={`No tests for ${symbol} yet`}>Run one on the left. It takes a few seconds.</Empty>
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
                    <td className="text-left">{r.params.estimator === "random_forest" ? `Forest, ${r.params.trees} trees, depth ${r.params.max_depth}` : `Boosting, ${r.params.trees} rounds`}</td>
                    <td>{pct(r.params.threshold, 2)}</td>
                    <td>{pct(r.metrics.summary.scores.model.balanced_accuracy)}</td>
                    <td>{(r.metrics.summary.edge * 100).toFixed(1)}</td>
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
