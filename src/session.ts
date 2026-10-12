import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";

// Shell sessions live here, outside React: splitting a pane moves it to another
// place in the tree, which remounts its component. If the component owned the
// shell, every split would kill it. The component only borrows `el`.

// cwd: last folder the shell's prompt reported (OSC 9;9, see pty.rs)
export type Session = { term: Terminal; fit: FitAddon; el: HTMLDivElement; cwd: string };

// App sets these; a session calls them for keys (return false = consumed), title changes and exit
export const handlers = {
  key: (_id: number, _e: KeyboardEvent) => true,
  title: (_id: number, _title: string) => {},
  exit: (_id: number) => {},
};

export const SHELLS = { powershell: "PowerShell", pwsh: "PowerShell 7", cmd: "cmd", "git-bash": "Git Bash" };
export type ShellKind = keyof typeof SHELLS;

const FONT_KEY = "will-terminal.fontSize";
const DEFAULT_FONT = 13;
let fontSize = Number(localStorage.getItem(FONT_KEY)) || DEFAULT_FONT;

const sessions = new Map<number, Session>();
const output = listen<{ id: number; data: string }>("pty-output", (e) => sessions.get(e.payload.id)?.term.write(e.payload.data));
const exited = listen<number>("pty-exit", (e) => sessions.has(e.payload) && handlers.exit(e.payload));

// Colors from the app theme (CSS variables), so the terminal matches Neon light/dark
function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--background"),
    foreground: v("--foreground"),
    cursor: v("--primary"),
    cursorAccent: v("--background"),
    selectionBackground: v("--primary") + "55",
    black: "#1e2230",
    red: v("--destructive"),
    green: v("--success"),
    yellow: v("--warning"),
    blue: v("--lane-2"),
    magenta: v("--primary"),
    cyan: v("--lane-2"),
    white: v("--foreground"),
    brightBlack: v("--muted-foreground"),
    brightMagenta: v("--accent-foreground"),
  };
}

export function getSession(id: number, cwd: string, shell: ShellKind): Session {
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
  term.loadAddon(fit);
  // Ctrl+click opens in the browser, so a plain click can still select text
  term.loadAddon(new WebLinksAddon((e, url) => e.ctrlKey && openUrl(url)));
  term.open(el);
  const s = { term, fit, el, cwd };
  term.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("9;")) s.cwd = data.slice(2);
    return data.startsWith("9;");
  });
  // Right click: copies the selection, or pastes when there is none (like Windows Terminal)
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (term.hasSelection()) copy(term);
    else navigator.clipboard.readText().then((t) => term.paste(t), (err) => toast.error(String(err)));
  });
  sessions.set(id, s);

  // Only keydown runs actions; preventDefault there also stops the keypress, so no stray character reaches the shell
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Ctrl+C with a selection copies (like Windows Terminal); without one it is the usual interrupt
    if (e.ctrlKey && !e.shiftKey && e.key === "c" && term.hasSelection()) {
      copy(term);
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

  let started = false;
  // Listeners must exist before the shell starts: ConPTY's first output is a question xterm must answer
  Promise.all([output, exited])
    .then(() => invoke("pty_spawn", { id, cwd, shellKind: shell, cols: term.cols, rows: term.rows }))
    .then(
      () => (started = true),
      (err) => {
        toast.error(String(err));
        handlers.exit(id);
      },
    );
  term.onData((data) => started && invoke("pty_write", { id, data }));
  term.onResize(({ cols, rows }) => started && invoke("pty_resize", { id, cols, rows }));
  return s;
}

function copy(term: Terminal) {
  navigator.clipboard.writeText(term.getSelection());
  term.clearSelection();
}

export const sessionCwd = (id: number) => sessions.get(id)?.cwd;
export const focusSession = (id: number) => sessions.get(id)?.term.focus();

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
