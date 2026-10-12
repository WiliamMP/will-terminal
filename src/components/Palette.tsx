import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { matches, type Command } from "../commands";

// initialQuery: opens already filtered (prefix + f shows the projects, prefix + = the copies)
type Props = { open: boolean; onOpenChange: (open: boolean) => void; commands: Command[]; initialQuery?: string };

// Command palette: type a few letters of any action and press Enter (port of will-repo's, without motion)
export function Palette({ open, onOpenChange, commands, initialQuery = "" }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setIndex(0);
    }
  }, [open]);

  const results = commands.filter((c) => matches(c, query));
  const byGroup = new Map<string, Command[]>();
  for (const c of results) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);

  useEffect(() => setIndex(0), [query]);
  // keep the highlighted item visible while moving with the arrows
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    // let the palette close (and give the focus back to the terminal) before the command runs
    setTimeout(c.run, 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, results.length - 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter") run(results[index]);
    else return;
    e.preventDefault();
  };

  let n = -1; // running index across groups
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm animate-in fade-in-0" />
        <Dialog.Content className="fixed top-[14%] left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-[0_0_60px_-12px_var(--glow)] animate-in fade-in-0 zoom-in-95">
          <Dialog.Title className="sr-only">Paleta de comandos</Dialog.Title>
          <Dialog.Description className="sr-only">Busque e execute qualquer ação</Dialog.Description>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 shrink-0 text-primary" />
            <input
              autoFocus
              placeholder="O que você quer fazer?"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
            <kbd className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">Esc</kbd>
          </div>
          <div ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
            {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nenhum comando.</p>}
            {[...byGroup].map(([group, items]) => (
              <div key={group} className="mb-1">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">{group}</p>
                {items.map((c) => {
                  const i = ++n;
                  const active = i === index;
                  return (
                    <button
                      key={c.id}
                      data-index={i}
                      onMouseMove={() => setIndex(i)}
                      onClick={() => run(c)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                        active && "bg-accent text-accent-foreground shadow-[inset_2px_0_0_var(--primary)]",
                      )}
                    >
                      <c.icon className={cn("size-4 shrink-0 text-muted-foreground", active && "text-primary")} />
                      <span className="flex-1 truncate">{c.title}</span>
                      {c.shortcut ? (
                        <kbd className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{c.shortcut}</kbd>
                      ) : (
                        active && <CornerDownLeft className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
