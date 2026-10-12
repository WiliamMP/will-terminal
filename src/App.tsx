import { useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "cn";
import {
  ArrowLeftRight,
  Columns2,
  Command as CommandIcon,
  Copy,
  Keyboard,
  Maximize2,
  Minus,
  Moon,
  Pencil,
  Plus,
  Rows2,
  Search,
  Settings as Gear,
  SquareTerminal,
  Sun,
  TextCursorInput,
  Type,
  X,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import type { Command } from "./commands";
import { Palette } from "./components/Palette";
import { SearchBar } from "./components/SearchBar";
import { PREFIXES, Settings, type PrefixKey, type Theme } from "./components/Settings";
import { IconButton } from "./components/ui";
import { dragWindow, WindowControls } from "./components/WindowControls";
import { isPane, leaves, neighbor, newId, remove, split, swap, type Dir, type Pane } from "./panes";
import {
  applyTheme,
  copySelection,
  focusSession,
  getSession,
  handlers,
  killSession,
  session,
  sessionCwd,
  SHELLS,
  writePane,
  zoomFont,
  type ShellKind,
} from "./session";

// A tab is a tmux "window": a tree of panes, the one with the cursor, whether it is zoomed,
// whether typing goes to all its panes (synchronize-panes), and a name given by the user
type Tab = { id: number; root: Pane; focus: number; zoom: boolean; sync: boolean; name?: string };

const SHELL_KEY = "will-terminal.shell";
const PREFIX_KEY = "will-terminal.prefix";
const THEME_KEY = "will-terminal.theme"; // also read by index.html, before React loads
const LAYOUT_KEY = "will-terminal.layout";
const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const FONT_KEYS: Record<string, number> = { "=": 1, "+": 1, "-": -1, "0": 0 };

const BINDINGS: [string, string][] = [
  ["%", "Dividir lado a lado"],
  ['"', "Dividir em cima/embaixo"],
  ["setas", "Mudar de painel"],
  ["o", "Próximo painel"],
  ["{ / }", "Trocar painel de lugar"],
  ["z", "Zoom no painel"],
  ["x", "Fechar painel"],
  ["c", "Nova aba"],
  ["n / p", "Próxima / anterior aba"],
  ["1-9", "Ir para a aba"],
  [",", "Renomear aba"],
  ["&", "Fechar aba"],
  ["[", "Modo cópia (q sai)"],
  [":", "Paleta de comandos"],
  ["?", "Esta ajuda"],
];
const GLOBAL_BINDINGS: [string, string][] = [
  ["Ctrl+Shift+P", "Paleta de comandos"],
  ["Ctrl+Shift+F", "Buscar no terminal"],
  ["Ctrl + / - / 0", "Tamanho da fonte"],
];

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = localStorage.getItem(key);
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function newTab(): Tab {
  const pane = newId();
  return { id: newId(), root: { kind: "leaf", id: pane }, focus: pane, zoom: false, sync: false };
}

type Saved = { tabs: Tab[]; active: number; cwds: Record<number, string> };

/** Layout of the last session, or null if there is none (or it is damaged) */
function loadLayout(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Saved | null;
    const ok = (t: Tab) => typeof t?.id === "number" && isPane(t.root) && leaves(t.root).includes(t.focus);
    if (v && Array.isArray(v.tabs) && v.tabs.length > 0 && v.tabs.every(ok)) return v;
  } catch {}
  return null;
}

/** Copy mode (prefix + [): the keys scroll the pane instead of going to the shell, like tmux */
// ponytail: selection is by mouse only; tmux's keyboard cursor (v to start, motions) needs its own cursor over the buffer
function copyModeKey(pane: number, e: KeyboardEvent): "stay" | "exit" | "search" {
  const term = session(pane)?.term;
  if (!term) return "exit";
  const k = e.key;
  if (k === "ArrowUp" || k === "k") term.scrollLines(-1);
  else if (k === "ArrowDown" || k === "j") term.scrollLines(1);
  else if (k === "PageUp" || (e.ctrlKey && k === "u")) term.scrollPages(-1);
  else if (k === "PageDown" || (e.ctrlKey && k === "d")) term.scrollPages(1);
  else if (k === "g" || k === "Home") term.scrollToTop();
  else if (k === "G" || k === "End") term.scrollToBottom();
  else if (k === "/") return "search";
  else if (k === "Enter" || k === "y") {
    copySelection(pane);
    return "exit";
  } else if (k === "q" || k === "Escape") return "exit";
  return "stay";
}

/** One shell: borrows the session's element, so moving the pane in the tree keeps the shell alive */
function Leaf(props: { id: number; focused: boolean; synced: boolean; cwd: string; shell: ShellKind; onFocus: () => void }) {
  const { id, focused, synced, cwd, shell, onFocus } = props;
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
    if (focused) focusSession(id);
  }, [focused, id]);

  return (
    <div
      ref={slot}
      data-pane={id}
      onMouseDown={onFocus}
      className={cn(
        "relative h-full overflow-hidden border transition-colors",
        focused ? "border-primary/70 shadow-[inset_0_0_14px_var(--glow)]" : "border-transparent opacity-80",
        synced && !focused && "border-warning/50",
      )}
    />
  );
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState(0);
  const [prefix, setPrefix] = useState(false);
  const [help, setHelp] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [searching, setSearching] = useState(false);
  const [copyMode, setCopyMode] = useState(false);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  // Folder each new pane starts in: the focused pane's folder when it was created, or the saved one on restore
  const startDir = useRef(new Map<number, string>());
  const [home, setHome] = useState("");
  const [shell, setShell] = useState<ShellKind>(() => read(SHELL_KEY, Object.keys(SHELLS) as ShellKind[], "powershell"));
  const [prefixKey, setPrefixKey] = useState<PrefixKey>(() => read(PREFIX_KEY, ["b", "a", " "], "b"));
  const [theme, setTheme] = useState<Theme>(() => read(THEME_KEY, ["system", "light", "dark"], "system"));

  const tab = tabs.find((t) => t.id === active);
  const index = tabs.findIndex((t) => t.id === active);
  const prefixLabel = PREFIXES[prefixKey];

  useEffect(() => {
    homeDir()
      .then(setHome, () => setHome("C:\\"))
      .then(() => {
        const saved = loadLayout();
        if (saved) {
          for (const [id, cwd] of Object.entries(saved.cwds ?? {})) startDir.current.set(+id, cwd);
          const restored = saved.tabs.map((t) => ({ ...t, zoom: false, sync: false }));
          setTabs(restored);
          setActive(restored.some((t) => t.id === saved.active) ? saved.active : restored[0].id);
        } else {
          const t = newTab();
          setTabs([t]);
          setActive(t.id);
        }
      })
      .finally(() => invoke("close_splash"));
  }, []);

  // Closing the window keeps the layout (tabs, panes, folders) for the next start; the shells themselves end
  const saveLayout = useRef(() => {});
  saveLayout.current = () => {
    const cwds: Record<number, string> = {};
    for (const t of tabs) for (const p of leaves(t.root)) cwds[p] = sessionCwd(p) ?? startDir.current.get(p) ?? home;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tabs, active, cwds } satisfies Saved));
  };
  useEffect(() => {
    const off = getCurrentWindow().onCloseRequested(() => saveLayout.current());
    return () => {
      off.then((f) => f());
    };
  }, []);

  // Theme: the .dark class drives the Neon tokens; the terminals repaint from them
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
      applyTheme();
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // Leaving tmux: the last pane closed ends the app and the next start is a fresh one
  function quit() {
    localStorage.removeItem(LAYOUT_KEY);
    getCurrentWindow().destroy();
  }

  function updateTab(f: (t: Tab) => Tab) {
    setTabs((ts) => ts.map((t) => (t.id === active ? f(t) : t)));
  }

  // New panes and tabs open in the focused pane's folder, when its prompt reported one
  function inheritDir(pane: number) {
    const cwd = tab && sessionCwd(tab.focus);
    if (cwd) startDir.current.set(pane, cwd);
  }

  function addTab() {
    const t = newTab();
    inheritDir(t.focus);
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  }

  function splitPane(dir: "row" | "col") {
    const id = newId();
    inheritDir(id);
    updateTab((t) => ({ ...t, root: split(t.root, t.focus, dir, id), focus: id, zoom: false }));
  }

  // Closing the last pane closes the tab; closing the last tab closes the app
  function closePane(pane: number) {
    killSession(pane);
    startDir.current.delete(pane);
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
    if (left.length === 0) return quit();
    setTabs(left);
    if (owner.id === active) setActive(left[Math.max(0, tabs.indexOf(owner) - 1)].id);
  }

  function closeTab(t: Tab) {
    // remove the tree first, so the shells' own exit events find nothing to close
    const left = tabs.filter((x) => x.id !== t.id);
    leaves(t.root).forEach((p) => {
      killSession(p);
      startDir.current.delete(p);
    });
    if (left.length === 0) return quit();
    setTabs(left);
    if (t.id === active) setActive(left[Math.max(0, tabs.indexOf(t) - 1)].id);
  }

  function moveFocus(dir: Dir) {
    if (!tab) return;
    const rects = new Map(
      leaves(tab.root).flatMap((id) => {
        const el = document.querySelector(`[data-pane="${id}"]`);
        return el ? [[id, el.getBoundingClientRect()] as const] : [];
      }),
    );
    const to = neighbor(rects, tab.focus, dir);
    if (to !== undefined) updateTab((t) => ({ ...t, focus: to }));
  }

  /** Moves the focused pane one place back (-1) or forward (+1) in the layout; the cursor goes with it */
  function swapPane(step: -1 | 1) {
    updateTab((t) => {
      const all = leaves(t.root);
      const other = all[(all.indexOf(t.focus) + step + all.length) % all.length];
      return { ...t, root: swap(t.root, t.focus, other), zoom: false };
    });
  }

  const cyclePane = () =>
    updateTab((t) => {
      const all = leaves(t.root);
      return { ...t, focus: all[(all.indexOf(t.focus) + 1) % all.length], zoom: false };
    });
  const toggleZoom = () => updateTab((t) => ({ ...t, zoom: !t.zoom }));
  const toggleSync = () => {
    if (tab) toast(tab.sync ? "Painéis independentes de novo" : "Digitando em todos os painéis da aba");
    updateTab((t) => ({ ...t, sync: !t.sync }));
  };
  const goTab = (step: number) => setActive(tabs[(index + step + tabs.length) % tabs.length].id);
  const enterCopyMode = () => setCopyMode(true);
  const exitCopyMode = () => {
    setCopyMode(false);
    if (tab) session(tab.focus)?.term.scrollToBottom();
  };

  // tmux keys: the prefix arms, the next key is a command. Returns true = key goes to the shell.
  function onKey(pane: number, e: KeyboardEvent): boolean {
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return !prefix && !copyMode; // Shift alone, on the way to % or "
    if (help && e.key === "Escape") {
      setHelp(false);
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === "KeyP") {
      setPalette(true);
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === "KeyF") {
      setSearching(true);
      return false;
    }
    if (e.ctrlKey && !e.altKey && e.key in FONT_KEYS) {
      zoomFont(FONT_KEYS[e.key]);
      return false;
    }
    const isPrefix = e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === prefixKey;
    if (copyMode && !prefix && !isPrefix) {
      const r = copyModeKey(pane, e);
      if (r === "exit") exitCopyMode();
      if (r === "search") setSearching(true);
      return false;
    }
    if (!prefix) {
      if (!isPrefix) return true;
      setPrefix(true);
      return false;
    }
    setPrefix(false);
    if (!tab) return false;
    // prefix twice sends the prefix itself (Ctrl+B = \x02, Ctrl+A = \x01, Ctrl+Space = \0)
    if (isPrefix) writePane(pane, prefixKey === " " ? "\0" : String.fromCharCode(prefixKey.charCodeAt(0) - 96));
    else if (e.key === "%") splitPane("row");
    else if (e.key === '"') splitPane("col");
    else if (e.key in ARROWS) moveFocus(ARROWS[e.key]);
    else if (e.key === "o") cyclePane();
    else if (e.key === "{") swapPane(-1);
    else if (e.key === "}") swapPane(1);
    else if (e.key === "z") toggleZoom();
    else if (e.key === "x") closePane(tab.focus);
    else if (e.key === "&") closeTab(tab);
    else if (e.key === "c") addTab();
    else if (e.key === "n") goTab(1);
    else if (e.key === "p") goTab(-1);
    else if (/^[1-9]$/.test(e.key) && tabs[+e.key - 1]) setActive(tabs[+e.key - 1].id);
    else if (e.key === ",") setEditing(tab.id);
    else if (e.key === "[") enterCopyMode();
    else if (e.key === ":") setPalette(true);
    else if (e.key === "?") setHelp(true);
    return false;
  }

  // Typed input goes to the pane, or to every pane of its tab when the tab is synced
  function onInput(pane: number, data: string) {
    const owner = tabs.find((t) => leaves(t.root).includes(pane));
    for (const p of owner?.sync ? leaves(owner.root) : [pane]) writePane(p, data);
  }

  // No dependency array: the session handlers always see the latest state (re-assigned every render)
  useEffect(() => {
    handlers.key = onKey;
    handlers.input = onInput;
    handlers.exit = closePane;
    handlers.title = (id, title) => setTitles((ts) => ({ ...ts, [id]: title }));
  });

  // Keys while the focus is outside the terminals (after clicking the bars): same shortcuts, nothing reaches a shell
  useEffect(() => {
    const onWindowKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (!tab || target.closest(".xterm") || target.closest("input, select, textarea, [role=dialog]")) return;
      if (!onKey(tab.focus, e)) e.preventDefault();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  });

  function changeShell(s: ShellKind) {
    setShell(s);
    localStorage.setItem(SHELL_KEY, s);
    toast(`Novos painéis vão abrir no ${SHELLS[s]}`);
  }
  function changePrefix(p: PrefixKey) {
    setPrefixKey(p);
    localStorage.setItem(PREFIX_KEY, p);
  }
  function changeTheme(t: Theme) {
    setTheme(t);
    localStorage.setItem(THEME_KEY, t);
  }

  const label = (t: Tab) => t.name || titles[t.focus]?.split(/[\\/]/).pop() || SHELLS[shell];

  // Empty name = back to the automatic one (the shell title)
  function rename(t: Tab, name: string) {
    setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, name: name.trim() || undefined } : x)));
    setEditing(null);
    focusSession(t.focus);
  }

  const P = (k: string) => `${prefixLabel} ${k}`;
  const commands: Command[] = [
    { id: "split-row", group: "Painéis", title: "Dividir lado a lado", icon: Columns2, keywords: "split vertical", shortcut: P("%"), run: () => splitPane("row") },
    { id: "split-col", group: "Painéis", title: "Dividir em cima/embaixo", icon: Rows2, keywords: "split horizontal", shortcut: P('"'), run: () => splitPane("col") },
    { id: "next-pane", group: "Painéis", title: "Próximo painel", icon: ArrowLeftRight, shortcut: P("o"), run: cyclePane },
    { id: "swap-back", group: "Painéis", title: "Trocar com o painel anterior", icon: ArrowLeftRight, keywords: "mover swap", shortcut: P("{"), run: () => swapPane(-1) },
    { id: "swap-next", group: "Painéis", title: "Trocar com o próximo painel", icon: ArrowLeftRight, keywords: "mover swap", shortcut: P("}"), run: () => swapPane(1) },
    { id: "zoom", group: "Painéis", title: tab?.zoom ? "Sair do zoom" : "Zoom no painel", icon: Maximize2, shortcut: P("z"), run: toggleZoom },
    { id: "sync", group: "Painéis", title: tab?.sync ? "Parar de digitar em todos os painéis" : "Digitar em todos os painéis da aba", icon: Keyboard, keywords: "sincronizar synchronize", run: toggleSync },
    { id: "close-pane", group: "Painéis", title: "Fechar painel", icon: X, shortcut: P("x"), run: () => tab && closePane(tab.focus) },
    { id: "new-tab", group: "Abas", title: "Nova aba", icon: Plus, shortcut: P("c"), run: addTab },
    { id: "next-tab", group: "Abas", title: "Próxima aba", icon: ArrowLeftRight, shortcut: P("n"), run: () => goTab(1) },
    { id: "prev-tab", group: "Abas", title: "Aba anterior", icon: ArrowLeftRight, shortcut: P("p"), run: () => goTab(-1) },
    { id: "rename-tab", group: "Abas", title: "Renomear aba", icon: Pencil, shortcut: P(","), run: () => tab && setEditing(tab.id) },
    { id: "close-tab", group: "Abas", title: "Fechar aba", icon: X, shortcut: P("&"), run: () => tab && closeTab(tab) },
    ...tabs.map((t, i) => ({ id: `tab-${t.id}`, group: "Abas", title: `Ir para ${i + 1}: ${label(t)}`, icon: SquareTerminal, run: () => setActive(t.id) })),
    { id: "search", group: "Terminal", title: "Buscar no terminal", icon: Search, keywords: "find procurar", shortcut: "Ctrl+Shift+F", run: () => setSearching(true) },
    { id: "copy-mode", group: "Terminal", title: "Modo cópia", icon: Copy, keywords: "rolar scroll selecionar", shortcut: P("["), run: enterCopyMode },
    { id: "font-up", group: "Terminal", title: "Aumentar fonte", icon: Type, keywords: "zoom maior", shortcut: "Ctrl +", run: () => zoomFont(1) },
    { id: "font-down", group: "Terminal", title: "Diminuir fonte", icon: Minus, keywords: "zoom menor", shortcut: "Ctrl -", run: () => zoomFont(-1) },
    { id: "font-reset", group: "Terminal", title: "Fonte no tamanho padrão", icon: Type, shortcut: "Ctrl 0", run: () => zoomFont(0) },
    ...(Object.keys(SHELLS) as ShellKind[]).map((s) => ({
      id: `shell-${s}`,
      group: "Shell",
      title: `Painéis novos no ${SHELLS[s]}`,
      icon: TextCursorInput,
      run: () => changeShell(s),
    })),
    { id: "theme-dark", group: "Aparência", title: "Tema escuro", icon: Moon, run: () => changeTheme("dark") },
    { id: "theme-light", group: "Aparência", title: "Tema claro", icon: Sun, run: () => changeTheme("light") },
    { id: "theme-system", group: "Aparência", title: "Tema do sistema", icon: Sun, run: () => changeTheme("system") },
    { id: "settings", group: "App", title: "Configurações", icon: Gear, keywords: "preferências prefixo", run: () => setSettings(true) },
    { id: "help", group: "App", title: "Atalhos de teclado", icon: Keyboard, keywords: "ajuda help", shortcut: P("?"), run: () => setHelp(true) },
  ];

  function render(p: Pane): React.ReactNode {
    if (p.kind === "leaf")
      return (
        <Leaf
          id={p.id}
          focused={p.id === tab?.focus}
          synced={!!tab?.sync}
          cwd={startDir.current.get(p.id) ?? home}
          shell={shell}
          onFocus={() => updateTab((t) => ({ ...t, focus: p.id }))}
        />
      );
    return (
      <Group key={p.id} orientation={p.dir === "row" ? "horizontal" : "vertical"} className="h-full">
        <Panel id={`${p.a.id}`} minSize={60}>
          {render(p.a)}
        </Panel>
        <Separator
          className={cn("bg-border transition-colors outline-none hover:bg-primary focus-visible:bg-primary", p.dir === "row" ? "w-px" : "h-px")}
        />
        <Panel id={`${p.b.id}`} minSize={60}>
          {render(p.b)}
        </Panel>
      </Group>
    );
  }

  // Dialogs give the focus back to the terminal when they close
  const backToTerminal = (open: boolean, set: (v: boolean) => void) => {
    set(open);
    if (!open && tab) setTimeout(() => focusSession(tab.focus), 0);
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <nav onMouseDown={dragWindow} className="flex h-10 shrink-0 items-end gap-1 border-b bg-sidebar pl-2 select-none">
          <div className="mr-2 grid size-7 shrink-0 place-items-center self-center rounded-md bg-primary/15 text-primary">
            <SquareTerminal size={18} />
          </div>
          {tabs.map((t, i) => (
            <div
              role="tab"
              aria-selected={t.id === active}
              key={t.id}
              onClick={() => setActive(t.id)}
              onDoubleClick={() => setEditing(t.id)}
              className={cn(
                "group flex h-8 max-w-48 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs text-muted-foreground transition-colors hover:text-foreground",
                t.id === active && "bg-background text-foreground shadow-[inset_0_2px_0_var(--primary)]",
              )}
            >
              <span className="font-mono text-primary">{i + 1}</span>
              {editing === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.name ?? label(t)}
                  aria-label="Nome da aba"
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => rename(t, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      setEditing(null);
                      focusSession(t.focus);
                    }
                  }}
                  className="w-28 rounded border border-ring bg-transparent px-1 outline-none"
                />
              ) : (
                <span className="truncate">{label(t)}</span>
              )}
              {t.zoom && <Maximize2 size={11} className="shrink-0 text-primary" />}
              {t.sync && <Keyboard size={11} className="shrink-0 text-warning" />}
              <X
                size={13}
                aria-label="Fechar aba"
                className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t);
                }}
              />
            </div>
          ))}
          <IconButton label={`Nova aba (${P("c")})`} onClick={addTab} className="mb-0.5 size-7">
            <Plus size={16} />
          </IconButton>
          <div onMouseDown={dragWindow} className="min-w-6 flex-1 self-stretch" />
          <div className="flex items-center gap-0.5 self-center">
            <IconButton label={`Dividir lado a lado (${P("%")})`} onClick={() => splitPane("row")} className="size-7">
              <Columns2 size={16} />
            </IconButton>
            <IconButton label={`Dividir em cima/embaixo (${P('"')})`} onClick={() => splitPane("col")} className="size-7">
              <Rows2 size={16} />
            </IconButton>
            <IconButton label="Paleta de comandos (Ctrl+Shift+P)" onClick={() => setPalette(true)} className="size-7">
              <CommandIcon size={16} />
            </IconButton>
            <IconButton label="Configurações" onClick={() => setSettings(true)} className="size-7">
              <Gear size={16} />
            </IconButton>
          </div>
          <div className="my-2.5 ml-2 w-px self-stretch bg-border" />
          <WindowControls />
        </nav>

        <main className="relative min-h-0 flex-1 p-1">
          {tab && (tab.zoom ? render({ kind: "leaf", id: tab.focus }) : render(tab.root))}
          {searching && tab && <SearchBar key={tab.focus} pane={tab.focus} onClose={() => setSearching(false)} />}
          {help && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/70 backdrop-blur-sm" onMouseDown={() => setHelp(false)}>
              <div className="w-96 rounded-lg border bg-card p-4 shadow-[0_0_40px_var(--glow)]">
                <h2 className="mb-3 flex items-center gap-2 font-medium">
                  <Keyboard size={16} className="text-primary" /> Atalhos (depois de {prefixLabel})
                </h2>
                {[BINDINGS, GLOBAL_BINDINGS].map((list, i) => (
                  <dl key={i} className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5", i > 0 && "mt-3 border-t pt-3")}>
                    {list.map(([k, d]) => (
                      <div key={k} className="contents">
                        <dt>
                          <kbd className="rounded bg-muted px-1.5 font-mono text-xs">{k}</kbd>
                        </dt>
                        <dd className="text-muted-foreground">{d}</dd>
                      </div>
                    ))}
                  </dl>
                ))}
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
            {prefix ? "PREFIXO" : prefixLabel}
          </span>
          {copyMode && <span className="rounded bg-warning px-1.5 text-background">CÓPIA · q sai</span>}
          {tab?.sync && (
            <button onClick={toggleSync} className="rounded bg-warning/20 px-1.5 text-warning" title="Parar de digitar em todos os painéis">
              SINCRONIZADO
            </button>
          )}
          {tab && (
            <span>
              [{index + 1}/{tabs.length}] {leaves(tab.root).length} {leaves(tab.root).length === 1 ? "painel" : "painéis"}
            </span>
          )}
          <span className="ml-auto">
            <button onClick={() => setHelp(true)} className="hover:text-foreground">
              {P("?")} atalhos
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
        <Palette open={palette} onOpenChange={(o) => backToTerminal(o, setPalette)} commands={commands} />
        <Settings
          open={settings}
          onOpenChange={(o) => backToTerminal(o, setSettings)}
          prefix={prefixKey}
          onPrefix={changePrefix}
          theme={theme}
          onTheme={changeTheme}
          shell={shell}
          onShell={changeShell}
        />
        <Toaster richColors />
      </div>
    </Tooltip.Provider>
  );
}
