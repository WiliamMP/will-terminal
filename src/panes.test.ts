import { expect, test } from "vitest";
import { isPane, isReply, leaves, neighbor, remove, split, swap, type Pane } from "./panes";

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

test("swap exchanges two leaves and keeps the shape", () => {
  const p = split(split(leaf(1), 1, "row", 2), 2, "col", 3);
  expect(leaves(swap(p, 1, 3))).toEqual([3, 2, 1]);
});

test("isPane accepts saved trees and rejects junk", () => {
  expect(isPane(split(leaf(1), 1, "row", 2))).toBe(true);
  expect(isPane({ kind: "split", id: 1, dir: "row", a: leaf(1) })).toBe(false);
  expect(isPane(null)).toBe(false);
});

test("isReply tells terminal answers from typed keys", () => {
  expect(isReply("\x1b[12;40R")).toBe(true); // cursor position
  expect(isReply("\x1b[?1;2c")).toBe(true); // device attributes
  expect(isReply("\x1b[I")).toBe(true); // focus in
  expect(isReply("\x1b[A")).toBe(false); // arrow up
  expect(isReply("ls\r")).toBe(false);
});
