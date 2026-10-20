import { Eye, SlidersHorizontal } from "lucide-react";

import type { ChartPrefs } from "../lib/api";
import { Button, NumberInput as NumberSetting, Pop, Segmented, Select, Switch } from "./ui";

const RANGES = [
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "5y", label: "5Y" },
  { value: "all", label: "All" },
];
// as far back as Yahoo serves each bar size: a week of 1-minute bars, two months of 5-minute, two years of hourly
const RANGES_FOR: Partial<Record<ChartPrefs["interval"], { value: string; label: string }[]>> = {
  "1m": [{ value: "1d", label: "1D" }, { value: "5d", label: "5D" }],
  "5m": [{ value: "5d", label: "5D" }, { value: "1m", label: "1M" }],
  "1h": RANGES.filter((r) => ["1m", "3m", "6m", "1y"].includes(r.value)),
};
const FIRST_RANGE: Record<ChartPrefs["interval"], string> = { "1m": "1d", "5m": "5d", "1h": "3m", "1d": "1y", "1w": "5y" };

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 py-1">{children}</div>;
}

export function ChartToolbar({ prefs, onChange }: { prefs: ChartPrefs; onChange: (p: ChartPrefs) => void }) {
  const set = (patch: Partial<ChartPrefs>) => onChange({ ...prefs, ...patch });
  const ranges = RANGES_FOR[prefs.interval] ?? RANGES;
  const ma = (key: "ma1" | "ma2", name: string) => (
    <Row>
      <Switch checked={prefs[key].on} onChange={(on) => set({ [key]: { ...prefs[key], on } })} label={name} />
      <div className="flex items-center gap-1.5">
        <Select
          label={`${name} type`}
          value={prefs[key].kind}
          onChange={(kind) => set({ [key]: { ...prefs[key], kind } })}
          options={[{ value: "ema", label: "EMA" }, { value: "sma", label: "SMA" }]}
        />
        <NumberSetting label={`${name} period`} value={prefs[key].period} min={2} max={400} onCommit={(period) => set({ [key]: { ...prefs[key], period } })} />
      </div>
    </Row>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        label="Bar size"
        value={prefs.interval}
        onChange={(interval) => {
          const allowed = (RANGES_FOR[interval] ?? RANGES).some((r) => r.value === prefs.range);
          set({ interval, range: allowed ? prefs.range : FIRST_RANGE[interval] });
        }}
        options={[
          { value: "1m", label: "1m", title: "1-minute bars" },
          { value: "5m", label: "5m", title: "5-minute bars" },
          { value: "1h", label: "1h", title: "Hourly bars" },
          { value: "1d", label: "D", title: "Daily bars" },
          { value: "1w", label: "W", title: "Weekly bars" },
        ]}
      />
      <Segmented size="sm" label="Range" value={prefs.range} onChange={(range) => set({ range })} options={ranges} />
      <Select
        label="Chart type"
        value={prefs.type}
        onChange={(type) => set({ type })}
        options={[
          { value: "candles", label: "Candles" },
          { value: "hollow", label: "Hollow candles" },
          { value: "heikin", label: "Heikin-Ashi" },
          { value: "bars", label: "OHLC bars" },
          { value: "line", label: "Line" },
          { value: "area", label: "Area" },
        ]}
      />
      <Pop
        trigger={
          <Button className="h-7 px-2">
            <SlidersHorizontal className="size-3.5" /> Indicators
          </Button>
        }
        className="w-80"
      >
        {ma("ma1", "Moving average 1")}
        {ma("ma2", "Moving average 2")}
        <Row>
          <Switch checked={prefs.bb.on} onChange={(on) => set({ bb: { ...prefs.bb, on } })} label="Bollinger bands" />
          <div className="flex items-center gap-1.5">
            <NumberSetting label="Bollinger period" value={prefs.bb.period} min={2} max={200} onCommit={(period) => set({ bb: { ...prefs.bb, period } })} />
            <NumberSetting label="Bollinger width" value={prefs.bb.width} min={0.5} max={5} step={0.1} onCommit={(width) => set({ bb: { ...prefs.bb, width } })} />
          </div>
        </Row>
        <Row>
          <Switch checked={prefs.rsi.on} onChange={(on) => set({ rsi: { ...prefs.rsi, on } })} label="RSI" />
          <NumberSetting label="RSI period" value={prefs.rsi.period} min={2} max={100} onCommit={(period) => set({ rsi: { ...prefs.rsi, period } })} />
        </Row>
        <Row>
          <Switch checked={prefs.macd.on} onChange={(on) => set({ macd: { on } })} label="MACD (12, 26, 9)" />
        </Row>
        <Row>
          <Switch checked={prefs.volume} onChange={(volume) => set({ volume })} label="Volume" />
        </Row>
      </Pop>
      <Pop
        trigger={
          <Button className="h-7 px-2">
            <Eye className="size-3.5" /> Show
          </Button>
        }
        className="w-64"
      >
        <Row>
          <Switch checked={prefs.calls} onChange={(calls) => set({ calls })} label="Model calls" />
        </Row>
        <Row>
          <Switch checked={prefs.fills} onChange={(fills) => set({ fills })} label="My fills" />
        </Row>
        <Row>
          <Switch checked={prefs.avgCost} onChange={(avgCost) => set({ avgCost })} label="Average cost line" />
        </Row>
        <Row>
          <Switch checked={prefs.orders} onChange={(orders) => set({ orders })} label="Open order lines" />
        </Row>
      </Pop>
      <Segmented
        size="sm"
        label="Price scale"
        value={prefs.scale}
        onChange={(scale) => set({ scale })}
        options={[
          { value: "linear", label: "Lin", title: "Linear scale" },
          { value: "log", label: "Log", title: "Logarithmic scale" },
          { value: "percent", label: "%", title: "Change since the first bar" },
        ]}
      />
    </div>
  );
}
