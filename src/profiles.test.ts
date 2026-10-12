import { expect, test } from "vitest";
import { parseEnv } from "./profiles";

test("parseEnv keeps NAME=value lines, values may contain =", () => {
  expect(parseEnv("NODE_ENV=development\n\n# comment\nURL=http://x?a=1\n=nope\nbare")).toEqual([
    ["NODE_ENV", "development"],
    ["URL", "http://x?a=1"],
  ]);
  expect(parseEnv(undefined)).toEqual([]);
});
