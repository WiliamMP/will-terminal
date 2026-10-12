import { useEffect, useRef, useState } from "react";
import { Play, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { StateIcon, type TabInfo } from "./TreeView";
import { Button } from "./ui";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: TabInfo[];
  /** panes checked when it opens: the current tab's */
  initial: number[];
  onRun: (cmd: string, panes: number[]) => void;
};

// Run one command in several panes, after seeing exactly where it will go. Enter in the command field only moves
// to the confirm button: nothing runs without that second step.
export function BatchRun({ open, onOpenChange, tabs, initial, onRun }: Props) {
  const [cmd, setCmd] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const runButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setCmd("");
      setSel(new Set(initial));
    }
  }, [open]);

  const all = tabs.flatMap((t) => t.panes);
  const chosen = all.filter((p) => sel.has(p.id) && !p.ended);
  const toggle = (ids: number[], on: boolean) =>
    setSel((s) => {
      const next = new Set(s);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-in fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(620px,92vw)] -translate-1/2 flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-[0_0_60px_-12px_var(--glow)] animate-in fade-in-0 zoom-in-95">
          <div className="flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 font-medium">
              <Play size={16} className="text-primary" /> Executar em vários painéis
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button size="icon" aria-label="Fechar" title="Fechar" className="size-7">
                <X size={15} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Escolha os painéis, confira e confirme</Dialog.Description>
          <input
            autoFocus
            value={cmd}
            placeholder="Comando (ex.: git pull)"
            aria-label="Comando"
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              runButton.current?.focus();
            }}
            className="rounded border border-input bg-transparent px-2 py-1.5 font-mono text-sm outline-none focus:border-ring"
          />
          <div className="min-h-0 flex-1 overflow-y-auto rounded border p-2 text-sm">
            {tabs.map((t) => {
              const ids = t.panes.filter((p) => !p.ended).map((p) => p.id);
              const allOn = ids.length > 0 && ids.every((id) => sel.has(id));
              return (
                <div key={t.id} className="mb-1">
                  <label className="flex items-center gap-2 py-0.5 font-medium">
                    <input type="checkbox" checked={allOn} onChange={(e) => toggle(ids, e.target.checked)} className="accent-primary" />
                    {t.label}
                  </label>
                  {t.panes.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 py-0.5 pl-6 text-muted-foreground">
                      <input
                        type="checkbox"
                        disabled={p.ended}
                        checked={sel.has(p.id) && !p.ended}
                        onChange={(e) => toggle([p.id], e.target.checked)}
                        className="accent-primary"
                      />
                      <span className="truncate font-mono text-xs" title={p.cwd}>
                        {p.cwd}
                      </span>
                      <StateIcon pane={p} />
                      {p.ended && <span className="text-xs text-destructive">encerrado</span>}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          {/* exactly what will be typed, and where */}
          <pre className="max-h-32 overflow-y-auto rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {chosen.length && cmd.trim() ? chosen.map((p) => `${p.cwd}> ${cmd}`).join("\n") : "Escolha painéis e escreva o comando."}
          </pre>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline">Cancelar</Button>
            </Dialog.Close>
            <Button
              ref={runButton}
              disabled={!cmd.trim() || chosen.length === 0}
              onClick={() => onRun(cmd, chosen.map((p) => p.id))}
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:shadow-[0_0_16px_var(--glow)]"
            >
              <Play size={14} /> Executar em {chosen.length} {chosen.length === 1 ? "painel" : "painéis"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
