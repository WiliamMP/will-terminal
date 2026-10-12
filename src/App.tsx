import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "cn";
import { Columns2, Keyboard, Maximize2, Plus, Rows2, SquareTerminal, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import { IconButton } from "./components/ui";
import { dragWindow, WindowControls } from "./components/WindowControls";
import { leaves, neighbor, newId, remove, split, type Dir, type Pane } from "./panes";
import { getSession, handlers, killSession, SHELLS, type ShellKind } from "./session";

// A tab is a tmux "window": a tree of panes, the one with the cursor, and whether it is zoomed
type Tab = { id: number; root: Pane; focus: number; zoom: boolean };

const SHELL_KEY = "will-terminal.shell";
const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

const BINDINGS: [string, string][] = [
  ["%", "Dividir lado a lado"],
  ['"', "Dividir em cima/embaixo"],
  ["setas", "Mudar de painel"],
  ["o", "Próximo painel"],
  ["z", "Zoom no painel"],
  ["x", "Fechar painel"],
  ["c", "Nova aba"],
  ["n / p", "Próxima / anterior aba"],
  ["1-9", "Ir para a aba"],
  ["&", "Fechar aba"],
  ["Ctrl+B", "Enviar Ctrl+B ao shell"],
  ["?", "Esta ajuda"],
];

function newTab(): Tab {
  const pane = newId();
  return { id: newId(), root: { kind: "leaf", id: pane }, focus: pane, zoom: false };
}

/** One shell: borrows the session's element, so moving the pane in the tree keeps the shell alive */
function Leaf({ id, focused, cwd, shell, onFocus }: { id: number; focused: boolean; cwd: string; shell: ShellKind; onFocus: () => void }) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = getSession(id, cwd, shell);
    slot.current!.appendChild(s.el);
    const observer = new ResizeObserver(() => s.fit.fit());
    observer.observe(slot.current!);
    return () => {
      observer.disconnect();
      s.el.remove();
    };
  }, [id]);

  useEffect(() => {
    if (focused) getSession(id, cwd, shell).term.focus();
  }, [focused, id]);

  return (
    <div
      ref={slot}
      data-pane={id}
      onMouseDown={onFocus}
      className={cn(
        "relative h-full overflow-hidden border transition-colors",
        focused ? "border-primary/70 shadow-[inset_0_0_14px_var(--glow)]" : "border-transparent opacity-80",
      )}
    />
  );
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState(0);
  const [prefix, setPrefix] = useState(false);
  const [help, setHelp] = useState(false);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [home, setHome] = useState("");
  const [shell, setShell] = useState<ShellKind>(() => {
    const saved = localStorage.getItem(SHELL_KEY);
    return saved && saved in SHELLS ? (saved as ShellKind) : "powershell";
  });

  const tab = tabs.find((t) => t.id === active);
  const index = tabs.findIndex((t) => t.id === active);

  useEffect(() => {
    homeDir()
      .then(setHome, () => setHome("C:\\"))
      .then(() => {
        const t = newTab();
        setTabs([t]);
        setActive(t.id);
      })
      .finally(() => invoke("close_splash"));
  }, []);

  function updateTab(f: (t: Tab) => Tab) {
    setTabs((ts) => ts.map((t) => (t.id === active ? f(t) : t)));
  }

  function addTab() {
    const t = newTab();
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  }

  function splitPane(dir: "row" | "col") {
    const id = newId();
    updateTab((t) => ({ ...t, root: split(t.root, t.focus, dir, id), focus: id, zoom: false }));
  }

  // Closing the last pane closes the tab; closing the last tab closes the app, like leaving tmux
  function closePane(pane: number) {
    killSession(pane);
    const owner = tabs.find((t) => leaves(t.root).includes(pane));
    if (!owner) return;
    const root = remove(owner.root, pane);
    if (root) {
      const rest = leaves(root);
      const focus = owner.focus === pane ? rest[Math.max(0, leaves(owner.root).indexOf(pane) - 1)] : owner.focus;
      setTabs((ts) => ts.map((t) => (t.id === owner.id ? { ...t, root, focus, zoom: false } : t)));
      return;
    }
    const left = tabs.filter((t) => t.id !== owner.id);
    if (left.length === 0) {
      getCurrentWindow().close();
      return;
    }
    setTabs(left);
    if (owner.id === active) setActive(left[Math.max(0, tabs.indexOf(owner) - 1)].id);
  }

  function closeTab(t: Tab) {
    // remove the tree first, so the shells' own exit events find nothing to close
    const left = tabs.filter((x) => x.id !== t.id);
    leaves(t.root).forEach(killSession);
    if (left.length === 0) {
      getCurrentWindow().close();
      return;
    }
    setTabs(left);
    if (t.id === active) setActive(left[Math.max(0, tabs.indexOf(t) - 1)].id);
  }

  function moveFocus(dir: Dir) {
    if (!tab) return;
    const rects = new Map(leaves(tab.root).flatMap((id) => {
      const el = document.querySelector(`[data-pane="${id}"]`);
      return el ? [[id, el.getBoundingClientRect()] as const] : [];
    }));
    const to = neighbor(rects, tab.focus, dir);
    if (to !== undefined) updateTab((t) => ({ ...t, focus: to }));
  }

  // tmux keys: Ctrl+B arms the prefix, the next key is a command. Returns true = key goes to the shell.
  function onKey(pane: number, e: KeyboardEvent): boolean {
    if (help && e.key === "Escape") {
      setHelp(false);
      return false;
    }
    if (!prefix) {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        setPrefix(true);
        return false;
      }
      return true;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return false; // Shift alone, on the way to % or "
    setPrefix(false);
    if (!tab) return false;
    const all = leaves(tab.root);
    if (e.ctrlKey && e.key.toLowerCase() === "b") invoke("pty_write", { id: pane, data: "\x02" });
    else if (e.key === "%") splitPane("row");
    else if (e.key === '"') splitPane("col");
    else if (e.key in ARROWS) moveFocus(ARROWS[e.key]);
    else if (e.key === "o") updateTab((t) => ({ ...t, focus: all[(all.indexOf(t.focus) + 1) % all.length], zoom: false }));
    else if (e.key === "z") updateTab((t) => ({ ...t, zoom: !t.zoom }));
    else if (e.key === "x") closePane(tab.focus);
    else if (e.key === "&") closeTab(tab);
    else if (e.key === "c") addTab();
    else if (e.key === "n") setActive(tabs[(index + 1) % tabs.length].id);
    else if (e.key === "p") setActive(tabs[(index - 1 + tabs.length) % tabs.length].id);
    else if (/^[1-9]$/.test(e.key) && tabs[+e.key - 1]) setActive(tabs[+e.key - 1].id);
    else if (e.key === "?") setHelp(true);
    return false;
  }

  // No dependency array: the session handlers always see the latest state (re-assigned every render)
  useEffect(() => {
    handlers.key = onKey;
    handlers.exit = closePane;
    handlers.title = (id, title) => setTitles((ts) => ({ ...ts, [id]: title }));
  });

  function changeShell(s: ShellKind) {
    setShell(s);
    localStorage.setItem(SHELL_KEY, s);
    toast(`Novos painéis vão abrir no ${SHELLS[s]}`);
  }

  const label = (t: Tab) => titles[t.focus]?.split(/[\\/]/).pop() || SHELLS[shell];

  function render(p: Pane): React.ReactNode {
    if (p.kind === "leaf")
      return (
        <Leaf id={p.id} focused={p.id === tab?.focus} cwd={home} shell={shell} onFocus={() => updateTab((t) => ({ ...t, focus: p.id }))} />
      );
    return (
      <Group key={p.id} orientation={p.dir === "row" ? "horizontal" : "vertical"} className="h-full">
        <Panel id={`${p.a.id}`} minSize={60}>
          {render(p.a)}
        </Panel>
        <Separator
          className={cn(
            "bg-border transition-colors outline-none hover:bg-primary focus-visible:bg-primary",
            p.dir === "row" ? "w-px" : "h-px",
          )}
        />
        <Panel id={`${p.b.id}`} minSize={60}>
          {render(p.b)}
        </Panel>
      </Group>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <nav onMouseDown={dragWindow} className="flex h-10 shrink-0 items-end gap-1 border-b bg-sidebar pl-2 select-none">
          <div className="mr-2 grid size-7 shrink-0 place-items-center self-center rounded-md bg-primary/15 text-primary">
            <SquareTerminal size={18} />
          </div>
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={cn(
                "group flex h-8 max-w-48 items-center gap-2 rounded-t-md px-3 text-xs text-muted-foreground transition-colors hover:text-foreground",
                t.id === active && "bg-background text-foreground shadow-[inset_0_2px_0_var(--primary)]",
              )}
            >
              <span className="font-mono text-primary">{i + 1}</span>
              <span className="truncate">{label(t)}</span>
              {t.zoom && <Maximize2 size={11} className="shrink-0 text-primary" />}
              <X
                size={13}
                aria-label="Fechar aba"
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t);
                }}
              />
            </button>
          ))}
          <IconButton label="Nova aba (Ctrl+B c)" onClick={addTab} className="mb-0.5 size-7">
            <Plus size={16} />
          </IconButton>
          <div onMouseDown={dragWindow} className="min-w-6 flex-1 self-stretch" />
          <div className="flex items-center gap-0.5 self-center">
            <IconButton label="Dividir lado a lado (Ctrl+B %)" onClick={() => splitPane("row")} className="size-7">
              <Columns2 size={16} />
            </IconButton>
            <IconButton label='Dividir em cima/embaixo (Ctrl+B ")' onClick={() => splitPane("col")} className="size-7">
              <Rows2 size={16} />
            </IconButton>
          </div>
          <div className="my-2.5 ml-2 w-px self-stretch bg-border" />
          <WindowControls />
        </nav>

        <main className="relative min-h-0 flex-1 p-1">
          {tab && (tab.zoom ? render({ kind: "leaf", id: tab.focus }) : render(tab.root))}
          {help && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/70 backdrop-blur-sm" onMouseDown={() => setHelp(false)}>
              <div className="w-80 rounded-lg border bg-card p-4 shadow-[0_0_40px_var(--glow)]">
                <h2 className="mb-3 flex items-center gap-2 font-medium">
                  <Keyboard size={16} className="text-primary" /> Atalhos (depois de Ctrl+B)
                </h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  {BINDINGS.map(([k, d]) => (
                    <div key={k} className="contents">
                      <dt>
                        <kbd className="rounded bg-muted px-1.5 font-mono text-xs">{k}</kbd>
                      </dt>
                      <dd className="text-muted-foreground">{d}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </main>

        {/* Status bar, the tmux line at the bottom */}
        <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar px-2 font-mono text-[11px] text-muted-foreground select-none">
          <span
            className={cn(
              "rounded px-1.5 transition-all",
              prefix ? "bg-primary text-primary-foreground shadow-[0_0_12px_var(--glow)]" : "bg-muted",
            )}
          >
            {prefix ? "PREFIXO" : "Ctrl+B"}
          </span>
          {tab && (
            <span>
              [{index + 1}/{tabs.length}] {leaves(tab.root).length} {leaves(tab.root).length === 1 ? "painel" : "painéis"}
            </span>
          )}
          <span className="ml-auto">
            <button onClick={() => setHelp(true)} className="hover:text-foreground">
              Ctrl+B ? atalhos
            </button>
          </span>
          <select
            value={shell}
            aria-label="Shell para novos painéis"
            onChange={(e) => changeShell(e.target.value as ShellKind)}
            className="bg-transparent outline-none hover:text-foreground"
          >
            {Object.entries(SHELLS).map(([k, v]) => (
              <option key={k} value={k} className="bg-popover text-popover-foreground">
                {v}
              </option>
            ))}
          </select>
        </footer>
        <Toaster richColors />
      </div>
    </Tooltip.Provider>
  );
}
