import { expect, test } from "vitest";
import { parseCli, parseEnv } from "./profiles";

test("parseEnv keeps NAME=value lines, values may contain =", () => {
  expect(parseEnv("NODE_ENV=development\n\n# comment\nURL=http://x?a=1\n=nope\nbare")).toEqual([
    ["NODE_ENV", "development"],
    ["URL", "http://x?a=1"],
  ]);
  expect(parseEnv(undefined)).toEqual([]);
});

test("parseCli reads both flag forms and skips the program and unknown flags", () => {
  expect(parseCli(["will-terminal.exe", "--perfil", "dev", "--cmd=npm run dev", "--x", "--pasta", "."])).toEqual({
    profile: "dev",
    cmd: "npm run dev",
    dir: ".",
  });
  expect(parseCli(["will-terminal.exe", "--project", "will-repo"])).toEqual({ project: "will-repo" });
  expect(parseCli(["will-terminal.exe", "--perfil"])).toEqual({});
});
