import { expect, test } from "vitest";
import { leaves, neighbor, remove, split, type Pane } from "./panes";

const leaf = (id: number): Pane => ({ kind: "leaf", id });

test("split puts the new pane after the target, remove gives the space back", () => {
  let p = split(leaf(1), 1, "row", 2);
  p = split(p, 1, "col", 3);
  expect(leaves(p)).toEqual([1, 3, 2]);
  p = remove(p, 3)!;
  expect(leaves(p)).toEqual([1, 2]);
  p = remove(p, 1)!;
  expect(p).toEqual(leaf(2));
  expect(remove(p, 2)).toBeNull();
});

test("neighbor picks the closest pane fully in that direction", () => {
  // [1][2]
  // [1][3]
  const rects = new Map([
    [1, { left: 0, top: 0, right: 50, bottom: 100 }],
    [2, { left: 50, top: 0, right: 100, bottom: 50 }],
    [3, { left: 50, top: 50, right: 100, bottom: 100 }],
  ]);
  expect(neighbor(rects, 1, "right")).toBe(2); // tie on distance: first wins
  expect(neighbor(rects, 2, "down")).toBe(3);
  expect(neighbor(rects, 3, "left")).toBe(1);
  expect(neighbor(rects, 1, "left")).toBeUndefined();
});
