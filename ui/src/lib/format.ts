// Money is whole cents everywhere; these only turn it into text.

const grouped = new Intl.NumberFormat("en-US");
const MINUS = "−";

export function money(cents: number | null | undefined, { sign = false } = {}): string {
  if (cents == null) return "—";
  const abs = Math.abs(Math.round(cents));
  const text = `$${grouped.format(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
  if (cents < 0) return MINUS + text;
  return sign && cents > 0 ? `+${text}` : text;
}

/** A price without the dollar sign, for dense columns. */
export function price(cents: number | null | undefined): string {
  return cents == null ? "—" : money(cents).slice(1);
}

export function percent(fraction: number | null | undefined, { sign = false, digits = 2 } = {}): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  const text = `${Math.abs(fraction * 100).toFixed(digits)}%`;
  if (fraction < 0 && Number(text.slice(0, -1)) !== 0) return MINUS + text;
  return sign && fraction > 0 ? `+${text}` : text;
}

/** A balanced-accuracy gap as signed points: +2.8 */
export function points(x: number): string {
  return `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`;
}

/** "likely between -3.3 and +5.4 points" for a stored edge range, or "" for runs that don't have one */
export function edgeRange(range?: [number, number], tries?: number): string {
  if (!range) return "";
  const runs = tries && tries > 1 ? `, allowing for ${tries} runs on this data` : "";
  return `likely between ${points(range[0])} and ${points(range[1])} points${runs}`;
}

export function shares(n: number): string {
  return grouped.format(n);
}

/** A position's size: below zero shares it is a short. */
export const held = (n: number) => (n < 0 ? `${shares(-n)} short` : shares(n));

/** What a fill did, for receipts' toasts. */
export const filled = (f: { side: "BUY" | "SELL"; buy_in?: boolean }) => (f.buy_in ? "Bought back" : f.side === "BUY" ? "Bought" : "Sold");

export function arrow(change: number | null | undefined): string {
  if (!change) return "";
  return change > 0 ? "▲" : "▼";
}

const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const nyTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
const nyDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

export const dateTime = (ts: number) => timeFormat.format(ts * 1000);
/** Bar times are New York trading days and hours. */
export const marketDay = (ts: number) => nyDay.format(ts * 1000);
export const marketTime = (ts: number) => nyTime.format(ts * 1000);

/** Dollars typed by a person to whole cents, or null when it isn't a price. */
export function parseCents(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
