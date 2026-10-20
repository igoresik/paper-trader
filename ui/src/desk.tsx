// What the whole window shares: the settings, the active portfolio, the symbol on screen, and the ticket's preset.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { toast } from "sonner";

import { api, type ChartPrefs, type Settings, type Side } from "./lib/api";

export const DEFAULT_CHART: ChartPrefs = {
  type: "candles",
  interval: "1d",
  range: "1y",
  scale: "linear",
  ma1: { on: true, kind: "ema", period: 20 },
  ma2: { on: true, kind: "sma", period: 50 },
  bb: { on: false, period: 20, width: 2 },
  volume: true,
  rsi: { on: true, period: 14 },
  macd: { on: false },
  calls: true,
  fills: true,
  avgCost: true,
  orders: true,
};

export type View = "trade" | "portfolio" | "lab";
export interface Preset {
  side: Side;
  shares?: number;
  nonce: number;
}

interface Desk {
  settings: Settings;
  save: (changes: Partial<Settings>) => void;
  accountId: number | null;
  symbol: string;
  setSymbol: (s: string) => void;
  view: View;
  setView: (v: View) => void;
  preset: Preset | null;
  trade: (symbol: string, side: Side, shares?: number) => void;
  chart: ChartPrefs;
  theme: "dark" | "light";
}

const DeskContext = createContext<Desk | null>(null);

export function useDesk() {
  const desk = useContext(DeskContext);
  if (!desk) throw new Error("useDesk outside DeskProvider");
  return desk;
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.settings });
}

export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onMutate: (changes) => {
      const before = client.getQueryData<Settings>(["settings"]);
      if (before) client.setQueryData(["settings"], { ...before, ...changes });
      return before;
    },
    onError: (error, _changes, before) => {
      if (before) client.setQueryData(["settings"], before);
      toast.error("Couldn't save that setting", { description: error.message });
    },
    onSuccess: (saved) => client.setQueryData(["settings"], saved),
  });
}

function useResolvedTheme(pref: Settings["theme"]): "dark" | "light" {
  const query = "(prefers-color-scheme: dark)";
  const [systemDark, setSystemDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

export function DeskProvider({ settings, children }: { settings: Settings; children: React.ReactNode }) {
  const save = useSaveSettings();
  const theme = useResolvedTheme(settings.theme);
  const [symbol, setSymbol] = useState(settings.lab.symbol ?? "SPY");
  const [view, setView] = useState<View>("trade");
  const [preset, setPreset] = useState<Preset | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.updown = settings.updown;
  }, [theme, settings.updown]);

  const desk: Desk = {
    settings,
    save: (changes) => save.mutate(changes),
    accountId: settings.account_id,
    symbol,
    setSymbol,
    view,
    setView,
    preset,
    trade: (s, side, shares) => {
      setSymbol(s);
      setView("trade");
      setPreset({ side, shares, nonce: Date.now() });
    },
    chart: { ...DEFAULT_CHART, ...settings.chart },
    theme,
  };
  return <DeskContext.Provider value={desk}>{children}</DeskContext.Provider>;
}
