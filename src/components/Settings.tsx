import { useState } from "react";
import { FolderInput, Settings as Gear, Plus, Trash2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import type { Layout } from "../panes";
import { SHELLS, type ShellKind } from "../session";
import { Button, IconButton } from "./ui";

export type Theme = "system" | "light" | "dark";
export type PrefixKey = "b" | "a" | " ";
export type CloseAction = "background" | "quit";

/** A ready-made tab: its folder, shell, layout and one line per pane with the command it starts (empty = none) */
export type Profile = { id: string; name: string; cwd: string; shell: ShellKind; layout: Layout; commands: string[] };

export const PREFIXES: Record<PrefixKey, string> = { b: "Ctrl+B", a: "Ctrl+A", " ": "Ctrl+Espaço" };
const THEMES: Record<Theme, string> = { system: "Seguir o sistema", light: "Claro", dark: "Escuro" };
const CLOSE_ACTIONS: Record<CloseAction, string> = { background: "Continuar na bandeja", quit: "Sair do app" };
export const LAYOUTS: Record<Layout, string> = { row: "Lado a lado", col: "Empilhados", main: "Um grande + pilha" };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefix: PrefixKey;
  onPrefix: (p: PrefixKey) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  shell: ShellKind;
  onShell: (s: ShellKind) => void;
  closeAction: CloseAction;
  onCloseAction: (c: CloseAction) => void;
  profiles: Profile[];
  onProfiles: (f: (ps: Profile[]) => Profile[]) => void;
  /** folder of the focused pane, for "use current folder" */
  currentCwd: string;
  version: string;
  onCheckUpdate: () => void;
};

const input = "rounded border border-input bg-transparent px-2 py-1 outline-none focus:border-ring";

function Field<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${input} w-44`}>
        {(Object.entries(options) as [T, string][]).map(([k, v]) => (
          <option key={k} value={k} className="bg-popover text-popover-foreground">
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProfileForm({ profile, currentCwd, onChange }: { profile: Profile; currentCwd: string; onChange: (p: Profile) => void }) {
  const set = (patch: Partial<Profile>) => onChange({ ...profile, ...patch });
  return (
    <div className="space-y-1 rounded-md border p-3">
      <label className="flex items-center gap-3 py-1">
        <span className="w-16 shrink-0">Nome</span>
        <input value={profile.name} onChange={(e) => set({ name: e.target.value })} className={`${input} min-w-0 flex-1`} />
      </label>
      <label className="flex items-center gap-3 py-1">
        <span className="w-16 shrink-0">Pasta</span>
        <input
          value={profile.cwd}
          placeholder="Pasta do usuário"
          onChange={(e) => set({ cwd: e.target.value })}
          className={`${input} min-w-0 flex-1 font-mono text-xs`}
        />
        <IconButton label="Usar a pasta do painel atual" onClick={() => set({ cwd: currentCwd })} className="size-7">
          <FolderInput size={15} />
        </IconButton>
      </label>
      <Field label="Shell" value={profile.shell} options={SHELLS} onChange={(shell) => set({ shell })} />
      <Field label="Painéis" value={profile.layout} options={LAYOUTS} onChange={(layout) => set({ layout })} />
      <label className="block pt-1">
        <span>Comandos</span>
        <span className="ml-2 text-xs text-muted-foreground">uma linha por painel; linha vazia = painel sem comando</span>
        <textarea
          rows={3}
          value={profile.commands.join("\n")}
          placeholder={"npm run tauri dev\ngit status"}
          onChange={(e) => set({ commands: e.target.value.split("\n") })}
          className={`${input} mt-1 block w-full resize-y font-mono text-xs`}
        />
      </label>
    </div>
  );
}

// Preferences, saved in localStorage as soon as they change
export function Settings(p: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const edited = p.profiles.find((x) => x.id === editing);

  function addProfile() {
    const profile: Profile = { id: crypto.randomUUID(), name: "Novo perfil", cwd: p.currentCwd, shell: p.shell, layout: "row", commands: [""] };
    p.onProfiles((ps) => [...ps, profile]);
    setEditing(profile.id);
  }

  // Deletes right away; "Desfazer" puts it back in the same place
  function deleteProfile(x: Profile) {
    const at = p.profiles.indexOf(x);
    p.onProfiles((ps) => ps.filter((y) => y.id !== x.id));
    toast(`Perfil "${x.name}" apagado`, {
      action: { label: "Desfazer", onClick: () => p.onProfiles((ps) => [...ps.slice(0, at), x, ...ps.slice(at)]) },
    });
  }

  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-in fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(520px,92vw)] -translate-1/2 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-[0_0_60px_-12px_var(--glow)] animate-in fade-in-0 zoom-in-95">
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
          <Dialog.Description className="sr-only">Prefixo, tema, shell, perfis e atualizações</Dialog.Description>
          <Field label="Prefixo" value={p.prefix} options={PREFIXES} onChange={p.onPrefix} />
          <Field label="Tema" value={p.theme} options={THEMES} onChange={p.onTheme} />
          <Field label="Shell dos painéis novos" value={p.shell} options={SHELLS} onChange={p.onShell} />
          <Field label="Ao fechar a janela" value={p.closeAction} options={CLOSE_ACTIONS} onChange={p.onCloseAction} />
          <p className="pb-1 text-xs text-muted-foreground">
            Na bandeja, os terminais continuam rodando; abrir o app de novo volta para eles. Para sair de verdade: bandeja → Sair.
          </p>

          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <h3 className="font-medium">Perfis</h3>
            <Button variant="outline" onClick={addProfile} className="h-7">
              <Plus size={14} /> Novo perfil
            </Button>
          </div>
          {p.profiles.length === 0 && <p className="py-2 text-xs text-muted-foreground">Um perfil abre uma aba pronta: pasta, shell e um comando por painel.</p>}
          <ul className="mt-2 space-y-1">
            {p.profiles.map((x) => (
              <li key={x.id}>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing(editing === x.id ? null : x.id)}
                    className={`flex-1 truncate rounded px-2 py-1 text-left hover:bg-muted ${editing === x.id ? "bg-accent text-accent-foreground" : ""}`}
                  >
                    {x.name || "Sem nome"}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {x.commands.length} {x.commands.length === 1 ? "painel" : "painéis"} · {SHELLS[x.shell]}
                    </span>
                  </button>
                  <IconButton label="Apagar perfil" variant="danger" onClick={() => deleteProfile(x)} className="size-7">
                    <Trash2 size={14} />
                  </IconButton>
                </div>
                {edited?.id === x.id && (
                  <ProfileForm profile={x} currentCwd={p.currentCwd} onChange={(np) => p.onProfiles((ps) => ps.map((y) => (y.id === np.id ? np : y)))} />
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
            <span>will-terminal v{p.version}</span>
            <Button variant="outline" onClick={p.onCheckUpdate} className="h-7">
              Procurar atualizações
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
