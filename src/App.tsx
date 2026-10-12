import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { homeDir, join, resolve } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { cn } from "cn";
import {
  AppWindow,
  ArrowLeftRight,
  Check,
  CircleDot,
  RotateCcw,
  ChevronDown,
  CircleX,
  ClipboardPaste,
  FolderGit2,
  LayoutGrid,
  Loader2,
  Download,
  EyeOff,
  LayoutTemplate,
  LogOut,
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
import { DropdownMenu, Tooltip } from "radix-ui";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import type { Command } from "./commands";
import { Palette } from "./components/Palette";
import { SearchBar } from "./components/SearchBar";
import { LAYOUTS, PREFIXES, Settings, type CloseAction, type PrefixKey, type Theme } from "./components/Settings";
import { IconButton } from "./components/ui";
import { dragWindow, WindowControls } from "./components/WindowControls";
import { isPane, layoutTree, leaves, neighbor, newId, remove, split, swap, type Dir, type Layout, type Pane } from "./panes";
import { parseCli, parseEnv, type Profile } from "./profiles";
import {
  applyTheme,
  buffers,
  copySelection,
  focusSession,
  getSession,
  handlers,
  killSession,
  pasteInto,
  restartSession,
  session,
  sessionCwd,
  SHELLS,
  showExited,
  startLog,
  stopLog,
  writePane,
  zoomFont,
  type ShellKind,
  type Start,
} from "./session";
import { checkForUpdate } from "./updater";

// A tab is a tmux "window": a tree of panes, the one with the cursor, whether it is zoomed,
// whether typing goes to all its panes (synchronize-panes), a name given by the user and the last arrangement picked
type Tab = { id: number; root: Pane; focus: number; zoom: boolean; sync: boolean; name?: string; layout?: Layout };

// What the shell integration (OSC 133, see pty.rs) says about a pane's last command.
// "done" = ended, but the shell can't tell the exit code (cmd).
type PaneStatus = { state: "running" | "ok" | "error" | "done"; code?: number | null; since: number };

const SHELL_KEY = "will-terminal.shell";
const PREFIX_KEY = "will-terminal.prefix";
const THEME_KEY = "will-terminal.theme"; // also read by index.html, before React loads
const LAYOUT_KEY = "will-terminal.layout";
const CLOSE_KEY = "will-terminal.closeAction";
const PROFILES_KEY = "will-terminal.profiles";
const DETACHED_KEY = "will-terminal.detachedOnce";
const PROJECTS_KEY = "will-terminal.projectsRoot";
const LAYOUT_ORDER: Layout[] = ["row", "col", "main"];
// a command shorter than this never notifies: you were looking at it
const NOTIFY_AFTER_MS = 10_000;
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
  ["Espaço", "Alternar arranjo dos painéis"],
  ["[", "Modo cópia (q sai)"],
  ["]", "Colar a última cópia"],
  ["=", "Colar do histórico de cópias"],
  ["f", "Abrir projeto"],
  ["t", "Terminal flutuante (mostra/esconde)"],
  ["R", "Reiniciar painel"],
  ["P", "Gravar a saída do painel em arquivo"],
  ["d", "Desanexar: esconde na bandeja, os terminais continuam"],
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

type Saved = {
  tabs: Tab[];
  active: number;
  cwds: Record<number, string>;
  shells?: Record<number, ShellKind>;
  envs?: Record<number, [string, string][]>;
};

/** Layout of the last session, or null if there is none (or it is damaged) */
function loadLayout(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Saved | null;
    const ok = (t: Tab) => typeof t?.id === "number" && isPane(t.root) && leaves(t.root).includes(t.focus);
    if (v && Array.isArray(v.tabs) && v.tabs.length > 0 && v.tabs.every(ok)) return v;
  } catch {}
  return null;
}

const duration = (ms: number) => {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}min ${sec % 60}s`;
};

/** Local date and time for file names: 2026-10-11 23-40-05 */
function stamp(d = new Date()) {
  const n = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${n(d.getMonth() + 1)}-${n(d.getDate())} ${n(d.getHours())}-${n(d.getMinutes())}-${n(d.getSeconds())}`;
}

type Cli = { args: string[]; cwd: string };

async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

function loadProfiles(): Profile[] {
  try {
    const v = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x?.id === "string" && Array.isArray(x.commands) && x.shell in SHELLS) : [];
  } catch {
    return [];
  }
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
function Leaf(props: { id: number; focused: boolean; synced: boolean; start: Start; onFocus: () => void }) {
  const { id, focused, synced, start, onFocus } = props;
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = getSession(id, start);
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

/** Tab mark, most important first: a command running, one that failed, one that finished while away, new output */
function TabBadge({ panes, activity }: { panes: (PaneStatus["state"] | undefined)[]; activity?: "output" | "finished" }) {
  if (panes.includes("running")) return <Loader2 size={11} aria-label="Executando" className="shrink-0 animate-spin text-primary" />;
  if (panes.includes("error")) return <CircleX size={11} aria-label="Falhou" className="shrink-0 text-destructive" />;
  if (activity === "finished") return <Check size={11} aria-label="Terminou" className="shrink-0 text-success" />;
  if (activity === "output") return <span aria-label="Saída nova" className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_6px_var(--glow)]" />;
  return null;
}

/** Status bar: what the focused pane's last command did */
function PaneState({ status }: { status?: PaneStatus }) {
  if (!status) return null;
  if (status.state === "running")
    return (
      <span className="flex items-center gap-1 text-primary">
        <Loader2 size={11} className="animate-spin" /> executando
      </span>
    );
  if (status.state === "error")
    return (
      <span className="flex items-center gap-1 text-destructive">
        <CircleX size={11} /> código {status.code}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-success">
      <Check size={11} /> {status.state === "ok" ? "ok" : "terminou"}
    </span>
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
  // How each new pane starts, when not the defaults: the focused pane's folder when it was split,
  // the profile's folder/shell/command/variables, or what was saved on restore
  const starts = useRef(new Map<number, Partial<Start>>());
  const [status, setStatus] = useState<Record<number, PaneStatus>>({});
  // panes whose shell reported a prompt at least once: only those can be "running" (a custom prompt may never report)
  const integrated = useRef(new Set<number>());
  // panes opened by a profile with a command: their first prompt means "the command starts now"
  const pendingCmd = useRef(new Set<number>());
  // tabs out of view that printed something, or finished a command, since they were last shown
  const [activity, setActivity] = useState<Record<number, "output" | "finished">>({});
  const [paletteQuery, setPaletteQuery] = useState("");
  // panes whose shell ended with an error: kept on screen (with the code) until Enter restarts them
  const [exited, setExited] = useState<Record<number, number>>({});
  // panes whose output is being copied to a file (pipe-pane), with the file
  const [logging, setLogging] = useState<Record<number, string>>({});
  // the floating scratch terminal: one shell kept while hidden, gone when it exits
  const [popup, setPopup] = useState<{ id: number; visible: boolean } | null>(null);
  const [projectsRoot, setProjectsRoot] = useState(() => localStorage.getItem(PROJECTS_KEY) ?? "");
  const [projects, setProjects] = useState<string[]>([]);
  // first detach: explain where the window went, when it comes back
  const detachNotice = useRef(false);
  const [version, setVersion] = useState("");
  const [profiles, setProfilesState] = useState<Profile[]>(loadProfiles);
  const [closeAction, setCloseAction] = useState<CloseAction>(() => read(CLOSE_KEY, ["background", "quit"], "background"));
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
          for (const t of saved.tabs)
            for (const p of leaves(t.root)) {
              const sh = saved.shells?.[p];
              starts.current.set(p, { cwd: saved.cwds?.[p], shell: sh && sh in SHELLS ? sh : undefined, env: saved.envs?.[p] });
            }
          const restored = saved.tabs.map((t) => ({ ...t, zoom: false, sync: false }));
          setTabs(restored);
          setActive(restored.some((t) => t.id === saved.active) ? saved.active : restored[0].id);
        } else {
          const t = newTab();
          setTabs([t]);
          setActive(t.id);
        }
      })
      .then(() => invoke<Cli>("startup_args"))
      .then((c) => cliRef.current(c))
      .finally(() => invoke("close_splash"));
    getVersion().then(setVersion);
    checkForUpdate(true, () => saveLayout.current());
  }, []);

  // Closing the window keeps the layout (tabs, panes, folders) for the next start; the shells themselves end
  const saveLayout = useRef(() => {});
  saveLayout.current = () => {
    const cwds: Record<number, string> = {};
    const shells: Record<number, ShellKind> = {};
    const envs: Record<number, [string, string][]> = {};
    for (const t of tabs)
      for (const p of leaves(t.root)) {
        const st = starts.current.get(p);
        cwds[p] = sessionCwd(p) ?? st?.cwd ?? home;
        shells[p] = session(p)?.shell ?? st?.shell ?? shell;
        if (st?.env?.length) envs[p] = st.env;
      }
    // the profile commands are not saved: a restart should not run `npm run dev` again on its own
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tabs, active, cwds, shells, envs } satisfies Saved));
  };
  // The window's X either detaches (hide, shells keep running) or quits, per Settings; read through a ref, so one listener is enough
  const onClose = useRef((_e: { preventDefault: () => void }) => {});
  onClose.current = (e) => {
    if (closeAction === "background") {
      e.preventDefault();
      detach();
    } else saveLayout.current();
  };
  const onQuit = useRef(() => {});
  onQuit.current = () => quitAll();
  const cliRef = useRef((_c: Cli) => {});
  cliRef.current = (c) => {
    runCli(c).catch((err) => toast.error(String(err)));
  };
  useEffect(() => {
    const win = getCurrentWindow();
    const offs = [
      win.onCloseRequested((e) => onClose.current(e)),
      // "Sair" in the tray menu: save, then end
      listen("quit-requested", () => onQuit.current()),
      // will-terminal --perfil dev, typed while the app runs: the running one opens it
      listen<Cli>("cli", (e) => cliRef.current(e.payload)),
      win.onFocusChanged(({ payload }) => {
        if (!payload || !detachNotice.current) return;
        detachNotice.current = false;
        toast("Os terminais continuaram rodando em segundo plano", {
          description: "Fechar a janela só esconde o app na bandeja. Para sair de verdade: bandeja → Sair, ou Sair na paleta.",
          duration: 10000,
        });
      }),
    ];
    return () => offs.forEach((off) => off.then((f) => f()));
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
    invoke("exit_app");
  }

  /** Ends the app with every shell, keeping the layout for the next start */
  function quitAll() {
    saveLayout.current();
    invoke("exit_app");
  }

  /** tmux detach: the window hides in the tray and the shells keep running; opening the app again shows it */
  function detach() {
    if (!localStorage.getItem(DETACHED_KEY)) {
      localStorage.setItem(DETACHED_KEY, "1");
      detachNotice.current = true;
    }
    getCurrentWindow().hide();
  }

  function setProfiles(f: (ps: Profile[]) => Profile[]) {
    setProfilesState((ps) => {
      const next = f(ps);
      localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
      return next;
    });
  }

  /** A new tab laid out by the profile, each pane in its folder and shell, running its command */
  function openProfile(pr: Profile) {
    const commands = pr.commands.length ? pr.commands : [""];
    const ids = commands.map(() => newId());
    const env = parseEnv(pr.env);
    ids.forEach((id, i) => {
      const command = commands[i].trim() || undefined;
      starts.current.set(id, { cwd: pr.cwd.trim() || undefined, shell: pr.shell, command, env });
      if (command) pendingCmd.current.add(id);
    });
    const t: Tab = { id: newId(), root: layoutTree(ids, pr.layout), focus: ids[0], zoom: false, sync: false, name: pr.name || undefined };
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  }

  function updateTab(f: (t: Tab) => Tab) {
    setTabs((ts) => ts.map((t) => (t.id === active ? f(t) : t)));
  }

  // New panes and tabs open in the focused pane's folder, when its prompt reported one
  function inheritDir(pane: number) {
    const cwd = tab && sessionCwd(tab.focus);
    if (cwd) starts.current.set(pane, { cwd });
  }

  /** Sessionizer: a tab in a subfolder of the projects folder, named after it */
  async function openProject(name: string) {
    const t = { ...newTab(), name };
    starts.current.set(t.focus, { cwd: await join(projectsRoot, name) });
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  }

  /** Command line: open a profile, a project, or a tab in a folder running a command */
  async function runCli({ args, cwd }: Cli) {
    const req = parseCli(args);
    if (req.profile) {
      const pr = profiles.find((x) => x.name.toLowerCase() === req.profile!.toLowerCase());
      if (pr) openProfile(pr);
      else toast.error(`Perfil não encontrado: ${req.profile}`);
    }
    if (req.project) {
      if (projectsRoot.trim()) await openProject(req.project);
      else toast.error("Escolha a pasta de projetos nas Configurações");
    }
    if (req.cmd || req.dir) {
      const t = newTab();
      starts.current.set(t.focus, { cwd: req.dir ? await resolve(cwd, req.dir) : cwd || undefined, command: req.cmd });
      if (req.cmd) pendingCmd.current.add(t.focus);
      setTabs((ts) => [...ts, t]);
      setActive(t.id);
    }
  }

  /** A shell that ended: a clean exit (typed `exit`) closes its pane like tmux; an error keeps the pane and its
   *  output, with the code, until Enter restarts it */
  function onExit(pane: number, code: number | null) {
    if (pane === popup?.id) return closePopup();
    if (code === null || code === 0) return closePane(pane);
    integrated.current.delete(pane);
    setExited((x) => ({ ...x, [pane]: code }));
    setLogging(({ [pane]: _, ...rest }) => rest);
    setStatus((st) => ({ ...st, [pane]: { state: "error", code, since: Date.now() } }));
    showExited(pane, code, `Enter reinicia · ${P("x")} fecha`);
  }

  /** tmux respawn-pane: same pane, same folder, its start command again; the old output stays above */
  function restartPane(pane: number) {
    setExited(({ [pane]: _, ...rest }) => rest);
    setStatus(({ [pane]: _, ...rest }) => rest);
    setLogging(({ [pane]: _, ...rest }) => rest);
    integrated.current.delete(pane);
    if (session(pane)?.start.command) pendingCmd.current.add(pane);
    restartSession(pane);
    focusSession(pane);
  }

  /** tmux pipe-pane: copies what the pane prints, as plain text, to a .log file in the app's log folder */
  async function toggleLog(pane: number) {
    try {
      if (logging[pane]) {
        await stopLog(pane);
        toast("Gravação parada", { description: logging[pane] });
        setLogging(({ [pane]: _, ...rest }) => rest);
        return;
      }
      const owner = tabs.find((t) => leaves(t.root).includes(pane));
      const path = await startLog(pane, `${owner ? label(owner) : "painel"} ${stamp()}`);
      setLogging((l) => ({ ...l, [pane]: path }));
      toast.success("Gravando a saída do painel", { description: path, action: { label: "Abrir pasta", onClick: () => revealItemInDir(path) } });
    } catch (err) {
      toast.error(String(err));
    }
  }

  /** Scratch terminal over the layout, in the focused pane's folder; hiding keeps it, `exit` ends it */
  function togglePopup() {
    if (!popup) {
      const id = newId();
      const cwd = tab && sessionCwd(tab.focus);
      starts.current.set(id, cwd ? { cwd } : {});
      setPopup({ id, visible: true });
    } else if (popup.visible) {
      setPopup({ ...popup, visible: false });
      if (tab) focusSession(tab.focus);
    } else setPopup({ ...popup, visible: true });
  }

  function closePopup() {
    if (!popup) return;
    killSession(popup.id);
    forget(popup.id);
    setPopup(null);
    if (tab) focusSession(tab.focus);
  }

  function openPalette(query = "") {
    setPaletteQuery(query);
    setPalette(true);
  }

  // The projects are read when the palette opens, so a new folder shows up without restarting
  useEffect(() => {
    if (palette && projectsRoot.trim()) invoke<string[]>("list_dirs", { root: projectsRoot.trim() }).then(setProjects, () => setProjects([]));
  }, [palette, projectsRoot]);

  /** prefix + Space: the panes of the tab side by side, stacked, or one big plus a stack, in turn */
  function cycleLayout() {
    if (!tab) return;
    const next = LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(tab.layout ?? "main") + 1) % LAYOUT_ORDER.length];
    updateTab((t) => ({ ...t, root: layoutTree(leaves(t.root), next), layout: next, zoom: false }));
    toast(`Painéis: ${LAYOUTS[next].toLowerCase()}`, { duration: 1500 });
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

  function forget(pane: number) {
    starts.current.delete(pane);
    integrated.current.delete(pane);
    pendingCmd.current.delete(pane);
    setExited(({ [pane]: _, ...rest }) => rest);
    setLogging(({ [pane]: _, ...rest }) => rest);
    setStatus(({ [pane]: _, ...rest }) => rest);
  }

  // Closing the last pane closes the tab; closing the last tab closes the app
  function closePane(pane: number) {
    killSession(pane);
    forget(pane);
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
      forget(p);
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
      openPalette();
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
    // an ended shell: Enter restarts it, other keys have nowhere to go
    if (!prefix && !isPrefix && exited[pane] !== undefined) {
      if (e.key === "Enter") restartPane(pane);
      return false;
    }
    if (!prefix) {
      if (!isPrefix) return true;
      setPrefix(true);
      return false;
    }
    setPrefix(false);
    if (!tab) return false;
    // the floating terminal only knows how to hide (and to pass the prefix on)
    if (pane === popup?.id && !isPrefix && e.key !== "t") return false;
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
    else if (e.key === "d") detach();
    else if (e.key === ":") openPalette();
    else if (e.key === " ") cycleLayout();
    else if (e.key === "t") togglePopup();
    else if (e.key === "R") restartPane(tab.focus);
    else if (e.key === "P") toggleLog(tab.focus);
    else if (e.key === "=") openPalette("colar");
    else if (e.key === "]") {
      if (buffers[0]) pasteInto(pane, buffers[0]);
      else toast("Nada copiado ainda");
    } else if (e.key === "f") {
      if (projectsRoot.trim()) openPalette("projeto ");
      else {
        toast("Escolha a pasta de projetos nas Configurações");
        setSettings(true);
      }
    }
    else if (e.key === "?") setHelp(true);
    return false;
  }

  // Typed input goes to the pane, or to every pane of its tab when the tab is synced
  function onInput(pane: number, data: string) {
    const owner = tabs.find((t) => leaves(t.root).includes(pane));
    const targets = owner?.sync ? leaves(owner.root) : [pane];
    for (const p of targets) writePane(p, data);
    // Enter at a prompt starts a command; the next prompt (OSC 133;D) ends it
    if (!data.includes("\r")) return;
    const starting = targets.filter((p) => integrated.current.has(p) && status[p]?.state !== "running");
    if (starting.length)
      setStatus((st) => ({ ...st, ...Object.fromEntries(starting.map((p) => [p, { state: "running", since: Date.now() } as PaneStatus])) }));
  }

  function onOutput(pane: number) {
    const owner = tabs.find((t) => leaves(t.root).includes(pane));
    if (owner && owner.id !== active && !activity[owner.id]) setActivity((a) => ({ ...a, [owner.id]: "output" }));
  }

  function onDone(pane: number, code: number | null) {
    integrated.current.add(pane);
    if (pendingCmd.current.delete(pane)) {
      setStatus((st) => ({ ...st, [pane]: { state: "running", since: Date.now() } }));
      return;
    }
    const prev = status[pane];
    if (prev?.state !== "running") return; // the first prompt, or Enter inside a program
    const state = code === null ? "done" : code === 0 ? "ok" : "error";
    setStatus((st) => ({ ...st, [pane]: { state, code, since: Date.now() } }));
    const owner = tabs.find((t) => leaves(t.root).includes(pane));
    if (!owner) return;
    const away = owner.id !== active || !document.hasFocus();
    if (owner.id !== active) setActivity((a) => ({ ...a, [owner.id]: "finished" }));
    const took = Date.now() - prev.since;
    if (away && took >= NOTIFY_AFTER_MS)
      notify(state === "error" ? `Comando falhou (código ${code})` : "Comando terminou", `${label(owner)} · ${duration(took)}`).catch(() => {});
  }

  // Looking at a tab clears its activity mark
  useEffect(() => {
    setActivity(({ [active]: _, ...rest }) => rest);
  }, [active]);

  // No dependency array: the session handlers always see the latest state (re-assigned every render)
  useEffect(() => {
    handlers.key = onKey;
    handlers.input = onInput;
    handlers.output = onOutput;
    handlers.done = onDone;
    handlers.exit = onExit;
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
  function changeCloseAction(c: CloseAction) {
    setCloseAction(c);
    localStorage.setItem(CLOSE_KEY, c);
  }
  function changeProjectsRoot(root: string) {
    setProjectsRoot(root);
    localStorage.setItem(PROJECTS_KEY, root);
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
    { id: "layout", group: "Painéis", title: "Alternar arranjo dos painéis", icon: LayoutGrid, keywords: "layout grade", shortcut: P("Espaço"), run: cycleLayout },
    ...LAYOUT_ORDER.map((l) => ({
      id: `layout-${l}`,
      group: "Painéis",
      title: `Arranjo: ${LAYOUTS[l].toLowerCase()}`,
      icon: LayoutGrid,
      keywords: "layout",
      run: () => updateTab((t) => ({ ...t, root: layoutTree(leaves(t.root), l), layout: l, zoom: false })),
    })),
    { id: "restart", group: "Painéis", title: "Reiniciar painel", icon: RotateCcw, keywords: "respawn recarregar", shortcut: P("R"), run: () => tab && restartPane(tab.focus) },
    { id: "close-pane", group: "Painéis", title: "Fechar painel", icon: X, shortcut: P("x"), run: () => tab && closePane(tab.focus) },
    { id: "new-tab", group: "Abas", title: "Nova aba", icon: Plus, shortcut: P("c"), run: addTab },
    { id: "next-tab", group: "Abas", title: "Próxima aba", icon: ArrowLeftRight, shortcut: P("n"), run: () => goTab(1) },
    { id: "prev-tab", group: "Abas", title: "Aba anterior", icon: ArrowLeftRight, shortcut: P("p"), run: () => goTab(-1) },
    { id: "rename-tab", group: "Abas", title: "Renomear aba", icon: Pencil, shortcut: P(","), run: () => tab && setEditing(tab.id) },
    { id: "close-tab", group: "Abas", title: "Fechar aba", icon: X, shortcut: P("&"), run: () => tab && closeTab(tab) },
    ...tabs.map((t, i) => ({ id: `tab-${t.id}`, group: "Abas", title: `Ir para ${i + 1}: ${label(t)}`, icon: SquareTerminal, run: () => setActive(t.id) })),
    { id: "search", group: "Terminal", title: "Buscar no terminal", icon: Search, keywords: "find procurar", shortcut: "Ctrl+Shift+F", run: () => setSearching(true) },
    {
      id: "popup",
      group: "Terminal",
      title: popup?.visible ? "Esconder o terminal flutuante" : "Terminal flutuante",
      icon: AppWindow,
      keywords: "popup scratch",
      shortcut: P("t"),
      run: togglePopup,
    },
    {
      id: "log",
      group: "Terminal",
      title: tab && logging[tab.focus] ? "Parar de gravar a saída do painel" : "Gravar a saída do painel em arquivo",
      icon: CircleDot,
      keywords: "log pipe-pane salvar",
      shortcut: P("P"),
      run: () => tab && toggleLog(tab.focus),
    },
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
    ...buffers.map((b, i) => ({
      id: `buffer-${i}`,
      group: "Histórico de cópias",
      title: `Colar: ${b.replace(/\s+/g, " ").trim().slice(0, 60)}`,
      icon: ClipboardPaste,
      keywords: "buffer",
      shortcut: i === 0 ? P("]") : undefined,
      run: () => tab && pasteInto(tab.focus, b),
    })),
    ...projects.map((name) => ({
      id: `project-${name}`,
      group: "Projetos",
      title: `Projeto: ${name}`,
      icon: FolderGit2,
      run: () => openProject(name),
    })),
    ...profiles.map((pr) => ({
      id: `profile-${pr.id}`,
      group: "Perfis",
      title: `Abrir perfil: ${pr.name || "Sem nome"}`,
      icon: LayoutTemplate,
      keywords: pr.commands.join(" "),
      run: () => openProfile(pr),
    })),
    { id: "profiles", group: "Perfis", title: "Gerenciar perfis", icon: LayoutTemplate, keywords: "criar editar", run: () => setSettings(true) },
    { id: "detach", group: "App", title: "Desanexar (esconder na bandeja)", icon: EyeOff, keywords: "detach segundo plano", shortcut: P("d"), run: detach },
    { id: "quit", group: "App", title: "Sair (fecha todos os terminais)", icon: LogOut, keywords: "fechar quit", run: quitAll },
    { id: "update", group: "App", title: "Procurar atualizações", icon: Download, keywords: "versão update", run: () => checkForUpdate(false, () => saveLayout.current()) },
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
          start={{ ...starts.current.get(p.id), cwd: starts.current.get(p.id)?.cwd ?? home, shell: starts.current.get(p.id)?.shell ?? shell }}
          onFocus={() => updateTab((t) => ({ ...t, focus: p.id }))}
        />
      );
    return (
      <Group key={p.id} orientation={p.dir === "row" ? "horizontal" : "vertical"} className="h-full">
        <Panel id={`${p.a.id}`} minSize={60} defaultSize={`${p.size ?? 50}`}>
          {render(p.a)}
        </Panel>
        <Separator
          className={cn("bg-border transition-colors outline-none hover:bg-primary focus-visible:bg-primary", p.dir === "row" ? "w-px" : "h-px")}
        />
        <Panel id={`${p.b.id}`} minSize={60} defaultSize={`${100 - (p.size ?? 50)}`}>
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
              <TabBadge panes={leaves(t.root).map((p) => status[p]?.state)} activity={activity[t.id]} />
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
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                aria-label="Abrir perfil"
                title="Abrir perfil"
                className="mb-0.5 -ml-1 grid h-7 w-4 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronDown size={13} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={4}
                className="z-50 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-[0_0_30px_-8px_var(--glow)] animate-in fade-in-0 zoom-in-95"
              >
                {profiles.map((pr) => (
                  <DropdownMenu.Item
                    key={pr.id}
                    onSelect={() => openProfile(pr)}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <LayoutTemplate size={14} className="text-primary" /> {pr.name || "Sem nome"}
                  </DropdownMenu.Item>
                ))}
                {profiles.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
                <DropdownMenu.Item
                  onSelect={() => setSettings(true)}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-muted-foreground outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <Gear size={14} /> {profiles.length ? "Gerenciar perfis" : "Criar um perfil"}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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
          {popup?.visible && (
            <div className="absolute inset-0 z-30 grid bg-background/60 p-[5%] backdrop-blur-sm">
              <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-primary/50 bg-background shadow-[0_0_40px_-8px_var(--glow)]">
                <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-sidebar px-3 text-xs text-muted-foreground">
                  <AppWindow size={13} className="text-primary" /> Terminal flutuante
                  <span className="ml-auto font-mono text-[11px]">{P("t")} esconde · exit fecha</span>
                </div>
                <div className="relative min-h-0 flex-1">
                  <Leaf
                    id={popup.id}
                    focused
                    synced={false}
                    start={{ ...starts.current.get(popup.id), cwd: starts.current.get(popup.id)?.cwd ?? home, shell: starts.current.get(popup.id)?.shell ?? shell }}
                    onFocus={() => {}}
                  />
                </div>
              </div>
            </div>
          )}
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
          {tab && <PaneState status={status[tab.focus]} />}
          {tab && logging[tab.focus] && (
            <button
              onClick={() => revealItemInDir(logging[tab.focus])}
              title={`Gravando em ${logging[tab.focus]}`}
              className="flex items-center gap-1 rounded bg-destructive/15 px-1.5 text-destructive"
            >
              <CircleDot size={10} /> REC
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
        <Palette open={palette} onOpenChange={(o) => backToTerminal(o, setPalette)} commands={commands} initialQuery={paletteQuery} />
        <Settings
          open={settings}
          onOpenChange={(o) => backToTerminal(o, setSettings)}
          prefix={prefixKey}
          onPrefix={changePrefix}
          theme={theme}
          onTheme={changeTheme}
          shell={shell}
          onShell={changeShell}
          projectsRoot={projectsRoot}
          onProjectsRoot={changeProjectsRoot}
          closeAction={closeAction}
          onCloseAction={changeCloseAction}
          profiles={profiles}
          onProfiles={setProfiles}
          currentCwd={(tab && sessionCwd(tab.focus)) || home}
          version={version}
          onCheckUpdate={() => checkForUpdate(false, () => saveLayout.current())}
        />
        <Toaster richColors />
      </div>
    </Tooltip.Provider>
  );
}
