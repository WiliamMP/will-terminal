// Profiles: a ready-made tab (folder, shell, layout, environment and one command per pane)
import type { Layout } from "./panes";
import type { ShellKind } from "./session";

/** `commands`: one line per pane, empty = no command. `env`: "NAME=value" lines, as typed in Settings. */
export type Profile = { id: string; name: string; cwd: string; shell: ShellKind; layout: Layout; commands: string[]; env?: string };

/** "NAME=value" lines to pairs; blank lines, # comments and lines without a name are ignored */
export function parseEnv(text = ""): [string, string][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      const i = line.indexOf("=");
      return i > 0 ? [[line.slice(0, i).trim(), line.slice(i + 1)] as [string, string]] : [];
    });
}
