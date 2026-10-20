import { Check, ChevronDown, X } from "lucide-react";
import { Dialog as D, Popover as P, Select as S, Switch as Sw, ToggleGroup, Tooltip as T } from "radix-ui";
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type Tone = "buy" | "sell" | "plain" | "quiet";

const tones: Record<Tone, string> = {
  buy: "bg-buy text-white hover:brightness-110",
  sell: "bg-sell text-white hover:brightness-110",
  plain: "bg-raised text-ink border border-rule hover:border-ink-3",
  quiet: "text-ink-2 hover:text-ink hover:bg-raised",
};

export function Button({ tone = "plain", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      className={cx(
        "press inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium disabled:opacity-45",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        className={cx("press grid size-7 place-items-center rounded-md text-ink-2 hover:bg-raised hover:text-ink", className)}
        {...props}
      />
    </Tip>
  );
}

export function Segmented<V extends string>({
  value, onChange, options, label, size = "md", className,
}: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode; title?: string }[];
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as V)}
      aria-label={label}
      className={cx("inline-flex rounded-md bg-desk p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className={cx(
            "rounded-[5px] px-2 font-medium text-ink-2 hover:text-ink data-[state=on]:bg-raised data-[state=on]:text-ink data-[state=on]:shadow-sm",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

const field = "num rounded-md border border-rule bg-raised px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-buy focus:outline-none";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(field, "h-8 w-full", className)} {...props} />;
}

/** A number that only commits when it's valid and the field is left, so nothing refetches per keystroke. */
export function NumberInput({ value, min, max, step = 1, onCommit, label, className }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) onCommit(step === 1 ? Math.round(n) : n);
    else setText(String(value));
  };
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className={cx(field, "h-7 w-16 shrink-0 px-1 text-center", className)}
    />
  );
}

export function Select<V extends string>({ value, onChange, options, label, className }: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <S.Trigger
        aria-label={label}
        className={cx("press inline-flex h-7 items-center gap-1 rounded-md border border-rule bg-raised px-2 text-[13px] text-ink hover:border-ink-3", className)}
      >
        <S.Value />
        <S.Icon>
          <ChevronDown className="size-3.5 text-ink-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="z-50 min-w-36 overflow-hidden rounded-lg border border-rule bg-raised p-1 shadow-lg">
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className="flex h-7 cursor-default items-center justify-between gap-3 rounded-md px-2 text-[13px] text-ink outline-none data-[highlighted]:bg-desk"
              >
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator>
                  <Check className="size-3.5" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      <span>{label}</span>
      <Sw.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-rule transition-colors duration-150 data-[state=checked]:bg-buy"
      >
        <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
      </Sw.Root>
    </label>
  );
}

export function Tip({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-50 max-w-64 rounded-md bg-ink px-2 py-1 text-xs text-panel shadow">
          {text}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export function Pop({ trigger, children, align = "start", className }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end"; className?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={6}
          className={cx("z-50 rounded-lg border border-rule bg-raised p-3 text-ink shadow-xl outline-none", className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

export function Dialog({ open, onOpenChange, title, description, children, wide }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content
          className={cx(
            "fixed top-1/2 left-1/2 z-50 max-h-[86vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-rule bg-panel p-5 text-ink shadow-2xl outline-none",
            wide ? "max-w-3xl" : "max-w-md",
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-[15px] font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-0.5 text-ink-2">{description}</D.Description>}
            </div>
            {/* no tooltip here: the dialog focuses this button on open and would pop it straight away */}
            <D.Close aria-label="Close" className="press grid size-7 place-items-center rounded-md text-ink-2 hover:bg-raised hover:text-ink">
              <X className="size-4" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Up or down text with an arrow, so direction never rests on colour alone. */
export function Change({ cents, fraction, children, className }: { cents?: number | null; fraction?: number | null; children: ReactNode; className?: string }) {
  const value = cents ?? fraction ?? 0;
  return (
    <span className={cx("num whitespace-nowrap", value > 0 ? "text-up" : value < 0 ? "text-down" : "text-ink-2", className)}>
      {value > 0 ? "▲ " : value < 0 ? "▼ " : ""}
      {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid place-items-center px-6 py-8 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-80 text-ink-2">{children}</p>}
    </div>
  );
}
