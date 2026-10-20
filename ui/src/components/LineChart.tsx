import { ColorType, createChart, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

import { marketDay } from "../lib/format";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface Line {
  label: string;
  color: string; // a CSS variable name
  values: (number | null)[];
}

/** Lines on one axis (both indexed to 100), so two series compare without a second scale. */
export function LineChart({ t, lines, theme, height = 260 }: { t: number[]; lines: Line[]; theme: string; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chart = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--panel") }, textColor: css("--ink-2"), fontFamily: "IBM Plex Sans, system-ui, sans-serif", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--rule") } },
      rightPriceScale: { borderColor: css("--rule") },
      timeScale: { borderColor: css("--rule") },
      localization: { locale: "en-US", priceFormatter: (p: number) => p.toFixed(1), timeFormatter: (time: unknown) => marketDay(time as number) },
      handleScroll: false,
      handleScale: false,
    });
    for (const line of lines) {
      const series = chart.addSeries(LineSeries, { color: css(line.color), lineWidth: 2, priceLineVisible: false, title: line.label });
      series.setData(t.map((time, i) => (line.values[i] == null ? { time: time as UTCTimestamp } : { time: time as UTCTimestamp, value: line.values[i]! })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [t, lines, theme]);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-[12px] text-ink-2">
        {lines.map((line) => (
          <span key={line.label} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-4 rounded" style={{ background: `var(${line.color})` }} />
            {line.label} <b className="num font-medium text-ink">{line.values.at(-1)?.toFixed(1) ?? "—"}</b>
          </span>
        ))}
      </div>
      <div ref={box} style={{ height }} />
    </div>
  );
}
