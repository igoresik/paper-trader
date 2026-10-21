import type { ReactNode } from "react";

import type { ReportBase } from "../lib/api";
import { money, percent } from "../lib/format";
import { cx } from "./ui";

/** A signed figure in up/down colour, with proportional digits since it stands alone */
export function Signed({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const v = value ?? 0;
  return <span className={cx("whitespace-nowrap", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-2")}>{v > 0 ? "▲ " : v < 0 ? "▼ " : ""}{children}</span>;
}

/** A return as a signed percentage, or a dash when there's nothing to measure yet */
export function Return({ value }: { value: number | null | undefined }) {
  return value == null ? <>{"–"}</> : <Signed value={value}>{percent(value, { sign: true, digits: 1 })}</Signed>;
}

function Tile({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-rule p-3">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-1 text-[18px] font-semibold leading-tight">{children}</div>
      {note && <div className="mt-1 text-[11px] leading-snug text-ink-3">{note}</div>}
    </div>
  );
}

/** The trader's record as stat tiles; the last tile is whichever model comparison the page has */
export function ReportTiles({ r, model }: { r: ReportBase; model: { label: string; note: (days: number) => string; none: string } }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Tile label="Sales that made money" note={r.sells ? `${r.wins} of ${r.sells} sales` : "Shows up after your first sale"}>
        {r.sells ? percent(r.wins / r.sells, { digits: 0 }) : "–"}
      </Tile>
      <Tile label="Average win and loss" note="per sale, after costs">
        {r.avg_win_cents == null && r.avg_loss_cents == null ? "–" : (
          <>
            <Signed value={r.avg_win_cents}>{r.avg_win_cents == null ? "–" : money(r.avg_win_cents, { sign: true })}</Signed>
            <span className="text-ink-3"> / </span>
            <Signed value={r.avg_loss_cents}>{r.avg_loss_cents == null ? "–" : money(r.avg_loss_cents, { sign: true })}</Signed>
          </>
        )}
      </Tile>
      <Tile label="Biggest drop" note="from a high close to a later low one">
        {r.max_drawdown == null ? "–" : <Signed value={r.max_drawdown}>{percent(r.max_drawdown, { digits: 1 })}</Signed>}
      </Tile>
      <Tile label="Costs paid" note={`${money(r.commission_cents)} commission, ${money(r.slippage_cents)} slippage`}>
        {money(r.commission_cents + r.slippage_cents)}
      </Tile>
      <Tile label="In the market" note="share of days you held shares at the close">
        {r.time_in_market == null ? "–" : percent(r.time_in_market, { digits: 0 })}
      </Tile>
      <Tile label={model.label} note={r.model.days ? model.note(r.model.days) : model.none}>
        {r.model.days ? <Return value={r.model.return} /> : "–"}
      </Tile>
    </div>
  );
}
