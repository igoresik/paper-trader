import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Toaster } from "sonner";

import { TopBar } from "./components/TopBar";
import { DeskProvider, useDesk, useSettings } from "./desk";
import { api } from "./lib/api";
import { ModelLab } from "./views/ModelLab";
import { PortfolioView } from "./views/Portfolio";
import { SettingsDialog } from "./views/SettingsDialog";
import { Trade } from "./views/Trade";
import { Welcome } from "./views/Welcome";

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
      <main className="min-h-0 flex-1">
        {view === "trade" && <Trade portfolio={portfolio} />}
        {view === "portfolio" && <PortfolioView portfolio={portfolio} />}
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
