import { expect, test } from "vitest";
import { addHistory, decodeCmd, latestRuns, MAX_HISTORY, type HistoryEntry } from "./history";

const entry = (cmd: string, at: number): HistoryEntry => ({ cmd, cwd: "C:\\", code: 0, at, ms: 10, tab: "1", shell: "powershell" });

test("decodeCmd reads the prompt's base64, accents included", () => {
  expect(decodeCmd("ZWNobyBoaQ==")).toBe("echo hi");
  expect(decodeCmd(btoa(String.fromCharCode(...new TextEncoder().encode("echo ação"))))).toBe("echo ação");
  expect(decodeCmd("%%%")).toBe("");
});

test("addHistory keeps the newest first and stops at the limit; latestRuns keeps one per command", () => {
  let list: HistoryEntry[] = [];
  for (let i = 0; i < MAX_HISTORY + 5; i++) list = addHistory(list, entry(`cmd ${i % 3}`, i));
  expect(list).toHaveLength(MAX_HISTORY);
  expect(list[0].at).toBe(MAX_HISTORY + 4);
  // newest run first: 504 % 3 = 0
  expect(latestRuns(list).map((e) => e.cmd)).toEqual(["cmd 0", "cmd 2", "cmd 1"]);
});
