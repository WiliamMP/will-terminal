import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import { isReply } from "./panes";

// Shell sessions live here, outside React: splitting a pane moves it to another
// place in the tree, which remounts its component. If the component owned the
// shell, every split would kill it. The component only borrows `el`.

// cwd: last folder the shell's prompt reported (OSC 9;9, see pty.rs)
export type Session = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  cwd: string;
  shell: ShellKind;
  started: boolean;
};

// App sets these; a session calls them for keys (return false = consumed), typed input, output,
// the end of a command (its exit code, null when the shell can't tell), title changes and exit
export const handlers = {
  key: (_id: number, _e: KeyboardEvent) => true,
  input: (id: number, data: string) => writePane(id, data),
  output: (_id: number) => {},
  done: (_id: number, _code: number | null) => {},
  title: (_id: number, _title: string) => {},
  exit: (_id: number) => {},
};

export const SHELLS = { powershell: "PowerShell", pwsh: "PowerShell 7", cmd: "cmd", "git-bash": "Git Bash", wsl: "WSL" };
export type ShellKind = keyof typeof SHELLS;

const FONT_KEY = "will-terminal.fontSize";
const DEFAULT_FONT = 13;
let fontSize = Number(localStorage.getItem(FONT_KEY)) || DEFAULT_FONT;

const sessions = new Map<number, Session>();
const output = listen<{ id: number; data: string }>("pty-output", (e) => {
  const s = sessions.get(e.payload.id);
  if (!s) return;
  s.term.write(e.payload.data);
  handlers.output(e.payload.id);
});
const exited = listen<number>("pty-exit", (e) => sessions.has(e.payload) && handlers.exit(e.payload));

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Colors from the app theme (CSS variables), so the terminal matches Neon light/dark
function theme() {
  return {
    background: css("--background"),
    foreground: css("--foreground"),
    cursor: css("--primary"),
    cursorAccent: css("--background"),
    selectionBackground: css("--primary") + "55",
    black: "#1e2230",
    red: css("--destructive"),
    green: css("--success"),
    yellow: css("--warning"),
    blue: css("--lane-2"),
    magenta: css("--primary"),
    cyan: css("--lane-2"),
    white: css("--foreground"),
    brightBlack: css("--muted-foreground"),
    brightMagenta: css("--accent-foreground"),
  };
}

/** After the light/dark class changes: repaint every terminal with the new colors */
export function applyTheme() {
  const t = theme();
  for (const s of sessions.values()) s.term.options.theme = t;
}

/** How a pane starts. `command`: typed into the shell once it starts (profiles), as if the user did it. */
export type Start = { cwd: string; shell: ShellKind; command?: string; env?: [string, string][] };

export function getSession(id: number, { cwd, shell, command, env }: Start): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "absolute inset-0 pl-2 pt-1";
  const term = new Terminal({
    fontFamily: "'Geist Mono Variable', 'Cascadia Code', monospace",
    fontSize,
    cursorBlink: true,
    allowProposedApi: true,
    theme: theme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  // Ctrl+click opens in the browser, so a plain click can still select text
  term.loadAddon(new WebLinksAddon((e, url) => e.ctrlKey && openUrl(url)));
  term.open(el);
  const s: Session = { term, fit, search, el, cwd, shell, started: false };
  term.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) s.cwd = data.slice(2);
    return data.startsWith("9;");
  });
  // OSC 133;D[;code]: the prompt says the previous command ended (see pty.rs)
  term.parser.registerOscHandler(133, (data) => {
    if (!data.startsWith("D")) return false;
    const code = Number.parseInt(data.split(";")[1]);
    handlers.done(id, Number.isNaN(code) ? null : code);
    return true;
  });
  // Right click: copies the selection, or pastes when there is none (like Windows Terminal)
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(id);
    else navigator.clipboard.readText().then((t) => term.paste(t), (err) => toast.error(String(err)));
  });
  sessions.set(id, s);

  // Only keydown runs actions; preventDefault there also stops the keypress, so no stray character reaches the shell
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Ctrl+C with a selection copies (like Windows Terminal); without one it is the usual interrupt
    if (e.ctrlKey && !e.shiftKey && e.key === "c" && term.hasSelection()) {
      copySelection(id);
      e.preventDefault();
      return false;
    }
    // Ctrl+V: xterm skips it and the browser fires a real paste, which xterm handles (bracketed paste included)
    if (e.ctrlKey && e.key.toLowerCase() === "v") return false;
    if (handlers.key(id, e)) return true;
    e.preventDefault();
    return false;
  });
  term.onTitleChange((t) => handlers.title(id, t));

  // Listeners must exist before the shell starts: ConPTY's first output is a question xterm must answer
  Promise.all([output, exited])
    .then(() => invoke("pty_spawn", { id, cwd, shellKind: shell, env, cols: term.cols, rows: term.rows }))
    .then(
      () => {
        s.started = true;
        // the shell queues it until its prompt is ready, like keys typed while it loads
        if (command) writePane(id, command + "\r");
      },
      (err) => {
        toast.error(String(err));
        handlers.exit(id);
      },
    );
  // xterm's own answers (cursor position, device attributes, focus) belong to this pane only, never to synced ones
  term.onData((data) => (isReply(data) ? writePane(id, data) : handlers.input(id, data)));
  term.onResize(({ cols, rows }) => s.started && invoke("pty_resize", { id, cols, rows }));
  return s;
}

export function writePane(id: number, data: string) {
  if (sessions.get(id)?.started) invoke("pty_write", { id, data });
}

// Copy history (tmux buffers): the last copies, newest first. Memory only: copies can hold secrets.
const BUFFERS = 10;
export const buffers: string[] = [];

export function copySelection(id: number) {
  const term = sessions.get(id)?.term;
  if (!term?.hasSelection()) return;
  const text = term.getSelection();
  navigator.clipboard.writeText(text);
  term.clearSelection();
  const i = buffers.indexOf(text);
  if (i >= 0) buffers.splice(i, 1);
  buffers.unshift(text);
  buffers.length = Math.min(buffers.length, BUFFERS);
}

/** Pastes like the user did it (bracketed paste included), so multi-line text does not run line by line */
export const pasteInto = (id: number, text: string) => sessions.get(id)?.term.paste(text);

export const session = (id: number) => sessions.get(id);
export const sessionCwd = (id: number) => sessions.get(id)?.cwd;
export const focusSession = (id: number) => sessions.get(id)?.term.focus();

/** Search options with the Neon colors; decorations need #RRGGBB */
export const searchOptions = () => ({
  decorations: {
    matchBackground: css("--muted").slice(0, 7),
    matchOverviewRuler: css("--muted-foreground").slice(0, 7),
    activeMatchBackground: css("--primary").slice(0, 7),
    activeMatchColorOverviewRuler: css("--primary").slice(0, 7),
  },
});

/** delta = +1 / -1, or 0 to go back to the default; applies to every open terminal */
export function zoomFont(delta: number) {
  fontSize = delta === 0 ? DEFAULT_FONT : Math.min(32, Math.max(8, fontSize + delta));
  localStorage.setItem(FONT_KEY, String(fontSize));
  for (const s of sessions.values()) {
    s.term.options.fontSize = fontSize;
    s.fit.fit();
  }
}

export function killSession(id: number) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  invoke("pty_kill", { id });
  s.term.dispose();
}
