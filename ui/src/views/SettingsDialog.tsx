import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button, Dialog, Input, NumberInput, Segmented, Switch } from "../components/ui";
import { useDesk } from "../desk";
import { api, type Account } from "../lib/api";
import { money, parseCents } from "../lib/format";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 border-t border-rule py-4 first:border-t-0 first:pt-0">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div>{label}</div>
        {hint && <div className="text-[12px] text-ink-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function PortfolioRow({ account, current }: { account: Account; current: boolean }) {
  const client = useQueryClient();
  const { save } = useDesk();
  const [name, setName] = useState(account.name);
  const [resetting, setResetting] = useState(false);
  const [cash, setCash] = useState((account.starting_cash_cents / 100).toFixed(0));
  const refresh = () => ["accounts", "settings", "portfolio", "orders", "history", "equity"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
  const rename = useMutation({
    mutationFn: () => api.renameAccount(account.id, name),
    onSuccess: refresh,
    onError: (e) => (toast.error(e.message), setName(account.name)),
  });
  const reset = useMutation({
    mutationFn: () => api.resetAccount(account.id, parseCents(cash) ?? undefined),
    onSuccess: (fresh) => {
      refresh();
      setResetting(false);
      toast.success(`${fresh.name} starts again with ${money(fresh.cash_balance_cents)}`, { description: "The old ledger is kept, read-only." });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="grid gap-2 rounded-md border border-rule p-2.5">
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== account.name && rename.mutate()} aria-label="Portfolio name" className="h-7" />
        {current ? <span className="text-[12px] whitespace-nowrap text-ink-2">In use</span> : <Button className="h-7 px-2 text-xs" onClick={() => save({ account_id: account.id })}>Use</Button>}
        <Button tone="quiet" className="h-7 px-2 text-xs" onClick={() => setResetting(!resetting)}>Reset</Button>
      </div>
      {resetting && (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-ink-2">Start again with $</span>
          <Input value={cash} onChange={(e) => setCash(e.target.value)} className="h-7 w-28" aria-label="Starting cash" />
          <Button tone="sell" className="h-7 px-2 text-xs" disabled={!parseCents(cash) || reset.isPending} onClick={() => reset.mutate()}>Reset {account.name}</Button>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { settings, save, accountId } = useDesk();
  const client = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts(), enabled: open });
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: () => fetch("/health").then((r) => r.json()), enabled: open });
  const [newName, setNewName] = useState("");
  const [newCash, setNewCash] = useState("100000");
  const create = useMutation({
    mutationFn: () => api.openAccount(newName, parseCents(newCash) ?? 0),
    onSuccess: (a) => {
      client.invalidateQueries({ queryKey: ["accounts"] });
      save({ account_id: a.id });
      setNewName("");
      toast.success(`Opened ${a.name} with ${money(a.cash_balance_cents)}`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Settings" description="Saved on this computer as soon as you change them." wide>
      <Section title="Trading costs">
        <Row label="Commission per order" hint="A fixed fee, in dollars.">
          <NumberInput label="Commission per order" value={settings.commission_cents / 100} min={0} max={100} step={0.01} onCommit={(v) => save({ commission_cents: Math.round(v * 100) })} />
        </Row>
        <Row label="Commission on the order's value" hint="In percent; 0.1 is a tenth of a percent.">
          <NumberInput label="Commission percent" value={settings.commission_bps / 100} min={0} max={5} step={0.01} onCommit={(v) => save({ commission_bps: Math.round(v * 100) })} />
        </Row>
        <Row label="Slippage" hint="In basis points (0.01%). Market and stop fills pay this much worse than the quote.">
          <NumberInput label="Slippage" value={settings.slippage_bps} min={0} max={500} onCommit={(v) => save({ slippage_bps: v })} />
        </Row>
      </Section>
      <Section title="Orders">
        <Switch checked={settings.confirm_orders} onChange={(v) => save({ confirm_orders: v })} label="Ask me to confirm each order" />
        <Switch checked={settings.practice_mode} onChange={(v) => save({ practice_mode: v })} label="Practice mode: fill market orders at the last price while the market is closed" />
        <p className="text-[12px] text-ink-3">Off is how brokers work: an order placed while the market is closed waits for the next open. Practice mode is handy for learning outside US hours, but the fills are at stale prices.</p>
      </Section>
      <Section title="Updates">
        <Switch checked={settings.check_updates} onChange={(v) => save({ check_updates: v })} label="Check GitHub for a new version when the app starts" />
        <p className="text-[12px] text-ink-3">One request to GitHub per start. Nothing about you or your trades is sent.</p>
      </Section>
      <Section title="Look">
        <Row label="Theme">
          <Segmented size="sm" label="Theme" value={settings.theme} onChange={(theme) => save({ theme })} options={[{ value: "system", label: "Like Windows" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
        </Row>
        <Row label="Up and down colours" hint="Blue and orange stay clear for colour-blind eyes.">
          <Segmented size="sm" label="Up and down colours" value={settings.updown} onChange={(updown) => save({ updown })} options={[{ value: "green-red", label: "Green up" }, { value: "red-green", label: "Red up" }, { value: "blue-orange", label: "Blue and orange" }]} />
        </Row>
      </Section>
      <Section title="Portfolios">
        {accounts.map((a) => <PortfolioRow key={a.id} account={a} current={a.id === accountId} />)}
        <div className="flex items-center gap-2">
          <Input placeholder="New portfolio name" value={newName} onChange={(e) => setNewName(e.target.value)} className="h-7" />
          <span className="text-ink-2">$</span>
          <Input value={newCash} onChange={(e) => setNewCash(e.target.value)} className="h-7 w-28" aria-label="Starting cash for the new portfolio" />
          <Button className="h-7 px-2 text-xs" disabled={!newName.trim() || !parseCents(newCash) || create.isPending} onClick={() => create.mutate()}>Open</Button>
        </div>
      </Section>
      <Section title="About">
        <p className="text-ink-2">
          Paper Trader {health?.version ?? ""}. Fake money only: no broker, no real orders. Educational, not financial advice.
        </p>
        <p className="text-[12px] text-ink-3">
          Prices come from Yahoo Finance through yfinance, which Yahoo allows for personal use; quotes can be late or missing.
          Charts use TradingView Lightweight Charts&trade;, &copy; TradingView, Inc. (Apache License 2.0), <a className="text-buy hover:underline" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">tradingview.com</a>.
        </p>
      </Section>
    </Dialog>
  );
}
