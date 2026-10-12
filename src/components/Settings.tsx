import { Settings as Gear, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { SHELLS, type ShellKind } from "../session";
import { IconButton } from "./ui";

export type Theme = "system" | "light" | "dark";
export type PrefixKey = "b" | "a" | " ";

export const PREFIXES: Record<PrefixKey, string> = { b: "Ctrl+B", a: "Ctrl+A", " ": "Ctrl+Espaço" };
const THEMES: Record<Theme, string> = { system: "Seguir o sistema", light: "Claro", dark: "Escuro" };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefix: PrefixKey;
  onPrefix: (p: PrefixKey) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  shell: ShellKind;
  onShell: (s: ShellKind) => void;
};

function Field<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-44 rounded border border-input bg-transparent px-2 py-1 outline-none focus:border-ring"
      >
        {(Object.entries(options) as [T, string][]).map(([k, v]) => (
          <option key={k} value={k} className="bg-popover text-popover-foreground">
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

// Preferences, saved in localStorage as soon as they change
export function Settings(p: Props) {
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-in fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(420px,92vw)] -translate-1/2 rounded-lg border bg-popover p-4 text-popover-foreground shadow-[0_0_60px_-12px_var(--glow)] animate-in fade-in-0 zoom-in-95">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 font-medium">
              <Gear size={16} className="text-primary" /> Configurações
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Fechar" className="size-7">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Prefixo, tema e shell</Dialog.Description>
          <Field label="Prefixo" value={p.prefix} options={PREFIXES} onChange={p.onPrefix} />
          <Field label="Tema" value={p.theme} options={THEMES} onChange={p.onTheme} />
          <Field label="Shell dos painéis novos" value={p.shell} options={SHELLS} onChange={p.onShell} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
