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

/** What the command line asks for: `--perfil dev`, `--projeto x`, `--cmd "npm test"`, `--pasta .`
 *  (also `--profile`, `--project`, `--dir`, and the `--name=value` form). args[0] is the program. */
export type CliRequest = { profile?: string; project?: string; cmd?: string; dir?: string };

const CLI_FLAGS: Record<string, keyof CliRequest> = {
  perfil: "profile",
  profile: "profile",
  projeto: "project",
  project: "project",
  cmd: "cmd",
  pasta: "dir",
  dir: "dir",
};

export function parseCli(args: string[]): CliRequest {
  const req: CliRequest = {};
  for (let i = 1; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    const key = m && CLI_FLAGS[m[1]];
    if (!key) continue;
    const value = m[2] ?? args[++i];
    if (value !== undefined) req[key] = value;
  }
  return req;
}
