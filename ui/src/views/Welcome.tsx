import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cx } from "../components/ui";
import { api } from "../lib/api";
import { money, parseCents } from "../lib/format";

const STARTERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM"];
const CASH = [1_000_000, 2_500_000, 10_000_000];

export function Welcome() {
  const client = useQueryClient();
  const [name, setName] = useState("Main");
  const [cash, setCash] = useState<number | "custom">(10_000_000);
  const [custom, setCustom] = useState("50000");
  const [picks, setPicks] = useState(new Set(["SPY", "AAPL", "MSFT"]));
  const [step, setStep] = useState("");
  const cents = cash === "custom" ? parseCents(custom) : cash;

  const start = useMutation({
    mutationFn: async () => {
      setStep("Opening the account…");
      const account = await api.openAccount(name, cents ?? 0);
      await api.saveSettings({ account_id: account.id });
      for (const symbol of picks) {
        setStep(`Downloading five years of ${symbol}…`);
        try {
          await api.watch(symbol);
        } catch (e) {
          toast.error((e as Error).message);
        }
      }
    },
    onSuccess: () => ["accounts", "settings", "watchlist"].forEach((k) => client.invalidateQueries({ queryKey: [k] })),
    onError: (e) => (toast.error(e.message), setStep("")),
  });

  const toggle = (s: string) => setPicks((old) => {
    const next = new Set(old);
    if (!next.delete(s)) next.add(s);
    return next;
  });

  return (
    <div className="grid h-full place-items-center overflow-auto bg-desk p-6">
      <form
        onSubmit={(e) => (e.preventDefault(), start.mutate())}
        className="paper perforated w-full max-w-[460px] rounded-t-lg px-7 pt-7 pb-10"
        aria-labelledby="welcome-title"
      >
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="size-8" />
          <h1 id="welcome-title" className="text-[20px] font-semibold">Open a paper account</h1>
        </div>
        <p className="mt-2 text-[13px] text-paper-ink/70">
          Trade with pretend money against live US prices, and see what a simple prediction model would have done. Nothing here touches a real broker.
        </p>

        <label className="mt-6 grid gap-1">
          <span className="text-xs text-paper-ink/70">Name it</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="h-9 rounded-md border border-paper-rule bg-white/80 px-2.5 text-paper-ink focus:border-buy focus:outline-none" />
        </label>

        <fieldset className="mt-5">
          <legend className="mb-1.5 text-xs text-paper-ink/70">Starting cash</legend>
          <div className="flex flex-wrap gap-1.5">
            {CASH.map((c) => (
              <button key={c} type="button" onClick={() => setCash(c)} aria-pressed={cash === c} className={cx("press h-8 rounded-md px-3 font-mono text-[13px]", cash === c ? "bg-paper-ink text-white" : "bg-black/5 text-paper-ink hover:bg-black/10")}>
                {money(c).replace(".00", "")}
              </button>
            ))}
            <button type="button" onClick={() => setCash("custom")} aria-pressed={cash === "custom"} className={cx("press h-8 rounded-md px-3 text-[13px]", cash === "custom" ? "bg-paper-ink text-white" : "bg-black/5 text-paper-ink hover:bg-black/10")}>
              Other
            </button>
            {cash === "custom" && (
              <input aria-label="Starting cash in dollars" value={custom} onChange={(e) => setCustom(e.target.value)} className="h-8 w-28 rounded-md border border-paper-rule bg-white/80 px-2 font-mono text-paper-ink focus:border-buy focus:outline-none" />
            )}
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className="mb-1.5 text-xs text-paper-ink/70">Start watching</legend>
          <div className="flex flex-wrap gap-1.5">
            {STARTERS.map((s) => (
              <button key={s} type="button" onClick={() => toggle(s)} aria-pressed={picks.has(s)} className={cx("press h-7 rounded-full px-3 text-[12px] font-medium", picks.has(s) ? "bg-buy text-white" : "bg-black/5 text-paper-ink hover:bg-black/10")}>
                {s}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-paper-ink/60">You can add any US stock or ETF later.</p>
        </fieldset>

        <button
          type="submit"
          disabled={!name.trim() || !cents || start.isPending}
          className="press mt-7 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-buy text-[13px] font-semibold text-white disabled:opacity-45"
        >
          {start.isPending ? <><LoaderCircle className="size-4 animate-spin" /> {step}</> : `Open ${name.trim() || "account"} with ${cents ? money(cents) : "…"}`}
        </button>
        <p className="mt-3 text-center text-[11px] text-paper-ink/60">Educational, not financial advice.</p>
      </form>
    </div>
  );
}
