import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Check, CircleX, Loader2, SquareTerminal, TerminalSquare } from "lucide-react";
import { previewLines } from "../session";

export type PaneInfo = {
  id: number;
  cwd: string;
  shell: string;
  state?: "running" | "ok" | "error" | "done";
  code?: number | null;
  /** its shell ended (kept on screen with the exit code) */
  ended?: boolean;
};
export type TabInfo = { id: number; label: string; panes: PaneInfo[] };

export function StateIcon({ pane }: { pane: PaneInfo }) {
  if (pane.state === "running") return <Loader2 size={12} aria-label="Executando" className="shrink-0 animate-spin text-primary" />;
  if (pane.state === "error") return <CircleX size={12} aria-label={`Código ${pane.code}`} className="shrink-0 text-destructive" />;
  if (pane.state) return <Check size={12} aria-label="Terminou" className="shrink-0 text-success" />;
  return null;
}

const folder = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

type Props = { tabs: TabInfo[]; current?: number; onPick: (tab: number, pane?: number) => void; onClose: () => void };

// tmux choose-tree (prefix + w): every tab and pane, with its folder, state and last lines; Enter goes there
export function TreeView({ tabs, current, onPick, onClose }: Props) {
  const rows = tabs.flatMap((t) => [{ tab: t, pane: undefined as PaneInfo | undefined }, ...t.panes.map((p) => ({ tab: t, pane: p }))]);
  const [index, setIndex] = useState(() => Math.max(0, rows.findIndex((r) => r.pane?.id === current)));
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const sel = rows[Math.min(index, rows.length - 1)];
  const shown = sel?.pane ?? sel?.tab.panes[0];

  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (i: number) => rows[i] && onPick(rows[i].tab.id, rows[i].pane?.id);

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-background/70 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-label="Abas e painéis"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "j") setIndex((i) => Math.min(i + 1, rows.length - 1));
          else if (e.key === "ArrowUp" || e.key === "k") setIndex((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter") pick(index);
          else if (e.key === "Escape" || e.key === "q") onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
        className="flex h-[min(560px,90%)] w-[min(980px,94%)] overflow-hidden rounded-lg border bg-card shadow-[0_0_40px_-8px_var(--glow)] outline-none"
      >
        <ul ref={list} className="w-2/5 shrink-0 overflow-y-auto border-r p-2 text-sm">
          {rows.map((r, i) => (
            <li key={r.pane ? `p${r.pane.id}` : `t${r.tab.id}`} data-row={i}>
              <button
                onClick={() => setIndex(i)}
                onDoubleClick={() => pick(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left",
                  r.pane ? "pl-7 text-muted-foreground" : "font-medium",
                  i === index && "bg-accent text-accent-foreground shadow-[inset_2px_0_0_var(--primary)]",
                )}
              >
                {r.pane ? <TerminalSquare size={13} className="shrink-0" /> : <SquareTerminal size={14} className="shrink-0 text-primary" />}
                <span className="truncate">{r.pane ? folder(r.pane.cwd) : r.tab.label}</span>
                {r.pane && <StateIcon pane={r.pane} />}
                {r.pane?.ended && <span className="text-xs text-destructive">encerrado</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col">
          {shown && (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2 font-mono text-xs text-muted-foreground">
                <span className="truncate" title={shown.cwd}>
                  {shown.cwd}
                </span>
                <span className="ml-auto shrink-0">{shown.shell}</span>
              </div>
              <pre className="min-h-0 flex-1 overflow-hidden px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
                {previewLines(shown.id, 18).join("\n")}
              </pre>
            </>
          )}
          <div className="border-t px-3 py-1.5 font-mono text-[11px] text-muted-foreground">↑↓ escolher · Enter ir · Esc fechar</div>
        </div>
      </div>
    </div>
  );
}
