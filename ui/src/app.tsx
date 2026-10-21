import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Toaster } from "sonner";

import { TopBar } from "./components/TopBar";
import { DeskProvider, useDesk, useSettings } from "./desk";
import { api } from "./lib/api";
import { useStatus } from "./lib/live";
import { ModelLab } from "./views/ModelLab";
import { PortfolioView } from "./views/Portfolio";
import { Replay } from "./views/Replay";
import { SettingsDialog } from "./views/SettingsDialog";
import { Trade } from "./views/Trade";
import { Welcome } from "./views/Welcome";

/** Prices come from Yahoo; when it stops answering, say so instead of letting stale numbers pass for live ones */
function YahooDown() {
  const { yahoo } = useStatus();
  if (yahoo !== "down") return null;
  return (
    <p role="status" className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-[12px] text-ink">
      <b className="font-semibold">Can&rsquo;t reach Yahoo Finance.</b> Prices and charts may be out of date. Waiting orders stay in place and fill once prices come back; the app keeps trying.
    </p>
  );
}

function Desk() {
  const { accountId, view, theme } = useDesk();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio", accountId],
    queryFn: () => api.portfolio(accountId!),
    enabled: !!accountId,
    refetchInterval: 15_000,
  });
  return (
    <div className="flex h-full flex-col">
      <TopBar portfolio={portfolio} onSettings={() => setSettingsOpen(true)} />
      <YahooDown />
      <main className="min-h-0 flex-1">
        {view === "trade" && <Trade portfolio={portfolio} />}
        {view === "portfolio" && <PortfolioView portfolio={portfolio} />}
        {view === "replay" && <Replay />}
        {view === "lab" && <ModelLab />}
      </main>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster theme={theme} position="bottom-right" closeButton toastOptions={{ classNames: { toast: "!font-sans !text-[13px]" } }} />
    </div>
  );
}

export function App() {
  const settings = useSettings();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  if (settings.error || accounts.error)
    return <p className="p-8 text-ink-2">{(settings.error ?? accounts.error)!.message}</p>;
  if (!settings.data || !accounts.data)
    return (
      <p className="flex h-full items-center justify-center gap-2 text-ink-2">
        <LoaderCircle className="size-4 animate-spin" /> Opening the desk&hellip;
      </p>
    );
  const ready = accounts.data.length > 0 && settings.data.account_id != null;
  return <DeskProvider settings={settings.data}>{ready ? <Desk /> : <Welcome />}</DeskProvider>;
}
