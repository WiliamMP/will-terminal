import { expect, test } from "vitest";
import { matches } from "./commands";

test("every word must match, ignoring accents and case", () => {
  const c = { title: "Dividir lado a lado", group: "Painéis", keywords: "split" };
  expect(matches(c, "paineis div")).toBe(true);
  expect(matches(c, "SPLIT")).toBe(true);
  expect(matches(c, "aba")).toBe(false);
  expect(matches(c, "")).toBe(true);
});
