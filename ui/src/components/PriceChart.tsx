import {
  AreaSeries, BarSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries,
  LineSeries, LineStyle, PriceScaleMode, TickMarkType,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type SeriesType,
  type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";

import type { ChartData, ChartPrefs } from "../lib/api";
import { arrow, marketDay, marketTime, percent, price as fmtPrice } from "../lib/format";
import { heikinAshi, withPrice, type Candle } from "../lib/candles";
import { useQuote } from "../lib/live";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const INTRADAY: string[] = ["1m", "5m", "1h"];
const MODEL_INTERVALS: string[] = ["1d", "1h"]; // the intervals the model makes calls for
const BAR_SECONDS: Record<string, number> = { "1m": 60, "5m": 300 };
const at = (t: number) => t as UTCTimestamp;
const toLine = (t: number[], values: (number | null)[], scale = 1) =>
  t.map((time, i) => (values[i] == null ? { time: at(time) } : { time: at(time), value: (values[i] as number) / scale }));

interface Legend {
  open: number;
  high: number;
  low: number;
  close: number;
  change: number | null;
  volume: number;
  lines: { label: string; color: string; value: number | null }[];
  time: number;
}

interface Built {
  chart: IChartApi;
  main: ISeriesApi<SeriesType>;
  candles: boolean;
  series: Record<string, ISeriesApi<SeriesType>>;
  markers: ISeriesMarkersPluginApi<Time>;
  priceLines: IPriceLine[];
}

function legendAt(i: number, bars: Candle[], data: ChartData | null, prefs: ChartPrefs): Legend | null {
  const b = bars[i];
  if (!b || !data) return null;
  const value = (key: string, scale: number) => {
    const v = data.lines[key]?.[i];
    return v == null ? null : v / scale;
  };
  const lines: Legend["lines"] = [];
  if (prefs.ma1.on) lines.push({ label: `${prefs.ma1.kind.toUpperCase()} ${prefs.ma1.period}`, color: "var(--ma1)", value: value("ma1", 100) });
  if (prefs.ma2.on) lines.push({ label: `${prefs.ma2.kind.toUpperCase()} ${prefs.ma2.period}`, color: "var(--ma2)", value: value("ma2", 100) });
  if (prefs.rsi.on) lines.push({ label: `RSI ${prefs.rsi.period}`, color: "var(--osc)", value: value("rsi", 1) });
  const prev = bars[i - 1];
  return { ...b, change: prev ? b.close / prev.close - 1 : null, volume: data.bars.v[i] ?? 0, lines };
}

export function PriceChart({ data, prefs, theme, updown }: { data: ChartData; prefs: ChartPrefs; theme: string; updown: string }) {
  const box = useRef<HTMLDivElement>(null);
  const built = useRef<Built | null>(null);
  const raw = useRef<Candle[]>([]);
  const dataRef = useRef<ChartData | null>(null);
  const fitted = useRef("");
  const view = useRef<{ from: number; to: number } | null>(null); // the zoom kept across rebuilds
  const [hovered, setHovered] = useState<number | null>(null);
  const [, redraw] = useState(0);
  const quote = useQuote(data.symbol);
  // what needs new series; periods and markers are drawn into the existing ones
  const structure = JSON.stringify([
    data.symbol, data.interval, prefs.type, prefs.scale, prefs.volume, prefs.calls, prefs.ma1.on, prefs.ma2.on,
    prefs.bb.on, prefs.rsi.on, prefs.macd.on, theme, updown,
  ]);
  const zoom = `${data.symbol}|${data.interval}|${prefs.range}`;
  const marked = JSON.stringify([prefs.fills, prefs.avgCost, prefs.orders]);

  // build the chart for this layout; data updates below keep the zoom
  useEffect(() => {
    const el = box.current!;
    const c = {
      panel: css("--panel"), rule: css("--rule"), ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"),
      up: css("--up"), down: css("--down"), buy: css("--buy"), sell: css("--sell"), ma1: css("--ma1"), ma2: css("--ma2"),
      osc: css("--osc"),
    };
    const intraday = INTRADAY.includes(data.interval);
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: c.panel },
        textColor: c.ink2,
        fontFamily: "IBM Plex Sans, system-ui, sans-serif",
        fontSize: 11,
        panes: { separatorColor: c.rule, separatorHoverColor: alpha(c.buy, 0.3), enableResize: true },
      },
      grid: { vertLines: { color: alpha(c.rule, 0.45) }, horzLines: { color: alpha(c.rule, 0.45) } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: c.rule,
        mode: { linear: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage }[prefs.scale],
      },
      timeScale: {
        borderColor: c.rule,
        timeVisible: intraday,
        rightOffset: 3,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const ts = time as number;
          if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return marketTime(ts);
          const d = new Date(ts * 1000);
          const opts: Intl.DateTimeFormatOptions =
            type === TickMarkType.Year ? { year: "numeric" } : type === TickMarkType.Month ? { month: "short" } : { month: "short", day: "numeric" };
          return d.toLocaleDateString("en-US", { ...opts, timeZone: "America/New_York" });
        },
      },
      localization: {
        locale: "en-US",
        priceFormatter: (p: number) => p.toFixed(2),
        timeFormatter: (time: Time) => (intraday ? `${marketDay(time as number)} ${marketTime(time as number)} ET` : marketDay(time as number)),
      },
    });

    const candleColors = { upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, borderVisible: false };
    const kind = prefs.type;
    const main: ISeriesApi<SeriesType> =
      kind === "bars"
        ? chart.addSeries(BarSeries, { upColor: c.up, downColor: c.down })
        : kind === "line"
          ? chart.addSeries(LineSeries, { color: c.ink, lineWidth: 2 })
          : kind === "area"
            ? chart.addSeries(AreaSeries, { lineColor: c.buy, topColor: alpha(c.buy, 0.22), bottomColor: alpha(c.buy, 0), lineWidth: 2 })
            : kind === "hollow"
              ? chart.addSeries(CandlestickSeries, { ...candleColors, upColor: "rgba(0,0,0,0)", borderVisible: true, borderUpColor: c.up, borderDownColor: c.down })
              : chart.addSeries(CandlestickSeries, candleColors);

    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const series: Record<string, ISeriesApi<SeriesType>> = {};
    if (prefs.volume) {
      series.volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", ...quiet });
      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    if (prefs.ma1.on) series.ma1 = chart.addSeries(LineSeries, { color: c.ma1, lineWidth: 2, ...quiet });
    if (prefs.ma2.on) series.ma2 = chart.addSeries(LineSeries, { color: c.ma2, lineWidth: 2, ...quiet });
    if (prefs.bb.on) {
      for (const key of ["bb_upper", "bb_mid", "bb_lower"])
        series[key] = chart.addSeries(LineSeries, { color: alpha(c.ink3, key === "bb_mid" ? 0.5 : 0.9), lineWidth: 1, ...quiet });
    }
    let pane = 1;
    if (prefs.calls && MODEL_INTERVALS.includes(data.interval)) {
      // the model's calls as a strip under the price: one cell per bar, so years of calls stay readable
      series.calls = chart.addSeries(HistogramSeries, { ...quiet, priceScaleId: "calls", base: 0 }, pane);
      chart.priceScale("calls", pane).applyOptions({ visible: false, scaleMargins: { top: 0.15, bottom: 0.15 } });
      chart.panes()[pane].setHeight(18);
      pane += 1;
    }
    if (prefs.rsi.on) {
      series.rsi = chart.addSeries(LineSeries, { color: c.osc, lineWidth: 2, priceLineVisible: false }, pane);
      for (const level of [30, 70])
        series.rsi.createPriceLine({ price: level, color: c.ink3, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
      chart.panes()[pane].setHeight(96);
      pane += 1;
    }
    if (prefs.macd.on) {
      series.macd_hist = chart.addSeries(HistogramSeries, quiet, pane);
      series.macd = chart.addSeries(LineSeries, { color: c.ma2, lineWidth: 2, ...quiet }, pane);
      series.macd_signal = chart.addSeries(LineSeries, { color: c.ma1, lineWidth: 1, ...quiet }, pane);
      chart.panes()[pane].setHeight(96);
    }
    const markers = createSeriesMarkers(main, []);
    built.current = { chart, main, candles: kind !== "line" && kind !== "area", series, markers, priceLines: [] };
    chart.subscribeCrosshairMove((param) => {
      const i = param.time === undefined ? -1 : raw.current.findIndex((b) => b.time === param.time);
      setHovered(i < 0 ? null : i);
    });
    return () => {
      view.current = chart.timeScale().getVisibleLogicalRange();
      chart.remove();
      built.current = null;
    };
  }, [structure]);

  // fill the series; the visible range is kept unless the layout changed
  useEffect(() => {
    const b = built.current;
    if (!b) return;
    dataRef.current = data;
    const { t, o, h, l, c, v } = data.bars;
    raw.current = t.map((time, i) => ({ time, open: o[i] / 100, high: h[i] / 100, low: l[i] / 100, close: c[i] / 100 }));
    const candles = prefs.type === "heikin" ? heikinAshi(raw.current) : raw.current;
    b.main.setData(
      b.candles
        ? candles.map((k) => ({ ...k, time: at(k.time) }))
        : raw.current.map((k) => ({ time: at(k.time), value: k.close })),
    );
    const up = css("--up");
    const down = css("--down");
    b.series.volume?.setData(t.map((time, i) => ({ time: at(time), value: v[i], color: alpha(c[i] >= o[i] ? up : down, 0.35) })));
    for (const key of ["ma1", "ma2", "bb_upper", "bb_mid", "bb_lower", "macd", "macd_signal"])
      if (b.series[key] && data.lines[key]) b.series[key].setData(toLine(t, data.lines[key], 100));
    if (b.series.rsi && data.lines.rsi) b.series.rsi.setData(toLine(t, data.lines.rsi));
    if (b.series.macd_hist && data.lines.macd_hist)
      b.series.macd_hist.setData(
        t.map((time, i) => {
          const value = data.lines.macd_hist[i];
          return value == null ? { time: at(time) } : { time: at(time), value: value / 100, color: alpha(value >= 0 ? up : down, 0.55) };
        }),
      );

    const buy = css("--buy");
    const sell = css("--sell");
    if (b.series.calls) {
      const byTime = new Map(data.calls.map((call) => [call.ts, call]));
      b.series.calls.setData(
        t.map((time) => {
          const call = byTime.get(time);
          return call
            ? { time: at(time), value: 1, color: alpha(call.signal === "BUY" ? up : down, call.kind === "live" ? 0.9 : 0.35) }
            : { time: at(time) };
        }),
      );
    }
    const marks: SeriesMarker<Time>[] = [];
    if (prefs.fills)
      for (const f of data.fills)
        if (f.t != null)
          marks.push({
            time: at(f.t),
            position: f.side === "BUY" ? "belowBar" : "aboveBar",
            shape: f.side === "BUY" ? "arrowUp" : "arrowDown",
            color: f.side === "BUY" ? buy : sell,
            text: `${f.side === "BUY" ? "B" : "S"} ${f.shares}`,
          });
    b.markers.setMarkers(marks.sort((x, y) => (x.time as number) - (y.time as number)));

    b.priceLines.forEach((line) => b.main.removePriceLine(line));
    b.priceLines = [];
    if (prefs.avgCost && data.position)
      b.priceLines.push(
        b.main.createPriceLine({ price: data.position.avg_cost_cents / 100, color: css("--ink-2"), lineStyle: LineStyle.Dashed, lineWidth: 1, title: `Avg cost · ${data.position.shares}` }),
      );
    if (prefs.orders)
      for (const order of data.orders)
        b.priceLines.push(
          b.main.createPriceLine({
            price: order.price_cents / 100,
            color: order.side === "BUY" ? buy : sell,
            lineStyle: LineStyle.Dotted,
            lineWidth: 1,
            title: `${order.type === "LIMIT" ? "Limit" : "Stop"} ${order.side === "BUY" ? "buy" : "sell"} ${order.shares}`,
          }),
        );
    if (fitted.current !== zoom) {
      b.chart.timeScale().fitContent();
      fitted.current = zoom;
    } else if (view.current) {
      b.chart.timeScale().setVisibleLogicalRange(view.current); // a rebuilt chart keeps where you were looking
      view.current = null;
    }
    redraw((n) => n + 1);
  }, [data, structure, marked, zoom]);

  // the bar still forming follows the live price; on minute charts a new bar starts each minute
  useEffect(() => {
    const b = built.current;
    if (!b || !raw.current.length || !data.forming || quote?.session !== "regular" || !quote.price_cents || !quote.ts) return;
    raw.current = withPrice(raw.current, quote.price_cents / 100, quote.ts, BAR_SECONDS[data.interval] ?? 0);
    const next = raw.current.at(-1)!;
    if (!b.candles) b.main.update({ time: at(next.time), value: next.close });
    else if (prefs.type === "heikin") b.main.update({ ...heikinAshi(raw.current).at(-1)!, time: at(next.time) });
    else b.main.update({ ...next, time: at(next.time) });
    redraw((n) => n + 1);
  }, [quote, data.forming, data.interval, prefs.type]);

  // the hovered bar, or the latest one when the pointer is elsewhere
  const legend = legendAt(hovered ?? raw.current.length - 1, raw.current, dataRef.current, prefs);
  return (
    <div className="relative h-full min-h-0">
      <div ref={box} className="absolute inset-0" />
      <ChartLegend legend={legend} intraday={INTRADAY.includes(data.interval)} calls={prefs.calls && MODEL_INTERVALS.includes(data.interval)} />
    </div>
  );
}

function ChartLegend({ legend, intraday, calls }: { legend: Legend | null; intraday: boolean; calls: boolean }) {
  if (!legend) return null;
  const tone = legend.change == null ? "text-ink-2" : legend.change >= 0 ? "text-up" : "text-down";
  return (
    <div className="pointer-events-none absolute top-1.5 left-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-ink-2">
      <span className="text-ink">{intraday ? `${marketDay(legend.time)} ${marketTime(legend.time)}` : marketDay(legend.time)}</span>
      <span className="num">O <b className="font-medium text-ink">{fmtPrice(legend.open * 100)}</b></span>
      <span className="num">H <b className="font-medium text-ink">{fmtPrice(legend.high * 100)}</b></span>
      <span className="num">L <b className="font-medium text-ink">{fmtPrice(legend.low * 100)}</b></span>
      <span className="num">C <b className="font-medium text-ink">{fmtPrice(legend.close * 100)}</b></span>
      {legend.change != null && (
        <span className={`num ${tone}`}>
          {arrow(legend.change)} {percent(legend.change, { sign: true })}
        </span>
      )}
      <span className="num">Vol {new Intl.NumberFormat("en-US", { notation: "compact" }).format(legend.volume)}</span>
      {legend.lines.map((line) => (
        <span key={line.label} className="num inline-flex items-center gap-1">
          <i className="inline-block h-0.5 w-3 rounded" style={{ background: line.color }} />
          {line.label} <b className="font-medium text-ink">{line.value == null ? "—" : line.value.toFixed(2)}</b>
        </span>
      ))}
      {calls && (
        <span className="inline-flex items-center gap-1" title="The strip under the price shows the model's buy and sell calls, tested on bars it never trained on; the brightest cell is today's live call.">
          <i className="inline-block size-2 rounded-sm bg-[var(--up)]" />
          <i className="inline-block size-2 rounded-sm bg-[var(--down)]" />
          model calls in the strip below
        </span>
      )}
    </div>
  );
}
