// Command history: every command a prompt reported (OSC 7777;cmd, see pty.rs), with where it ran,
// how it ended and how long it took. Kept in localStorage, like the shells keep their own history files.
import type { ShellKind } from "./session";

export type HistoryEntry = { cmd: string; cwd: string; code: number | null; at: number; ms: number; tab: string; shell: ShellKind };

const KEY = "will-terminal.history";
export const MAX_HISTORY = 500;

/** The prompt sends the command as base64 of its UTF-8 bytes (so quotes, accents and line breaks survive) */
export function decodeCmd(b64: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** Newest first, at most MAX_HISTORY */
export const addHistory = (list: HistoryEntry[], e: HistoryEntry) => [e, ...list].slice(0, MAX_HISTORY);

/** One entry per command line, the most recent run of each: what the palette lists */
export function latestRuns(list: HistoryEntry[]) {
  const seen = new Set<string>();
  return list.filter((e) => !seen.has(e.cmd) && seen.add(e.cmd));
}

export function loadHistory(): HistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e) => typeof e?.cmd === "string" && typeof e.at === "number") : [];
  } catch {
    return [];
  }
}

export function saveHistory(list: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}
