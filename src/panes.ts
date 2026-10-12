// Pane layout of one tab, like a tmux window: a binary tree where each leaf is a
// shell (its id is the pty id) and each split holds two children side by side
// ("row") or stacked ("col"). Pure functions, so the tree is easy to test.

// size: percent of the split taken by `a` when it first shows (50 if missing); dragging changes it from there
export type Pane =
  | { kind: "leaf"; id: number }
  | { kind: "split"; id: number; dir: "row" | "col"; a: Pane; b: Pane; size?: number };

export type Dir = "left" | "right" | "up" | "down";

export const newId = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function leaves(p: Pane): number[] {
  return p.kind === "leaf" ? [p.id] : [...leaves(p.a), ...leaves(p.b)];
}

/** Replaces leaf `target` with a split of itself and a new leaf `id` (after it) */
export function split(p: Pane, target: number, dir: "row" | "col", id: number): Pane {
  if (p.kind === "leaf") return p.id === target ? { kind: "split", id: newId(), dir, a: p, b: { kind: "leaf", id } } : p;
  return { ...p, a: split(p.a, target, dir, id), b: split(p.b, target, dir, id) };
}

/** Removes leaf `target`; its sibling takes the whole space. null = tree is now empty */
export function remove(p: Pane, target: number): Pane | null {
  if (p.kind === "leaf") return p.id === target ? null : p;
  const a = remove(p.a, target);
  const b = remove(p.b, target);
  if (!a) return b;
  if (!b) return a;
  return { ...p, a, b };
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** Closest pane in a direction, by screen position (what tmux does with Ctrl+B + arrow) */
export function neighbor(rects: Map<number, Rect>, from: number, dir: Dir): number | undefined {
  const r = rects.get(from);
  if (!r) return;
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  let best: number | undefined;
  let bestDist = Infinity;
  for (const [id, o] of rects) {
    // must be fully past our edge in that direction
    const past =
      dir === "left" ? o.right <= r.left : dir === "right" ? o.left >= r.right : dir === "up" ? o.bottom <= r.top : o.top >= r.bottom;
    if (id === from || !past) continue;
    const dist = Math.hypot((o.left + o.right) / 2 - cx, (o.top + o.bottom) / 2 - cy);
    if (dist < bestDist) [best, bestDist] = [id, dist];
  }
  return best;
}

/** Exchanges the places of two leaves (tmux Ctrl+B { and }) */
export function swap(p: Pane, x: number, y: number): Pane {
  if (p.kind === "leaf") return p.id === x ? { ...p, id: y } : p.id === y ? { ...p, id: x } : p;
  return { ...p, a: swap(p.a, x, y), b: swap(p.b, x, y) };
}

/** A saved tree read back from disk: anything that is not a well-formed tree is rejected */
export function isPane(v: unknown): v is Pane {
  const p = v as Pane;
  if (typeof p?.id !== "number") return false;
  if (p.kind === "leaf") return true;
  const sizeOk = p.kind === "split" && (p.size === undefined || (typeof p.size === "number" && p.size > 0 && p.size < 100));
  return p.kind === "split" && sizeOk && (p.dir === "row" || p.dir === "col") && isPane(p.a) && isPane(p.b);
}

export type Layout = "row" | "col" | "main";

/** n panes of the same size side by side ("row"), stacked ("col"), or one big on the left and the rest stacked ("main") */
export function layoutTree(ids: number[], layout: Layout): Pane {
  const even = (rest: number[], dir: "row" | "col"): Pane =>
    rest.length === 1
      ? { kind: "leaf", id: rest[0] }
      : { kind: "split", id: newId(), dir, a: { kind: "leaf", id: rest[0] }, b: even(rest.slice(1), dir), size: 100 / rest.length };
  if (layout !== "main" || ids.length < 2) return even(ids, layout === "main" ? "row" : layout);
  return { kind: "split", id: newId(), dir: "row", a: { kind: "leaf", id: ids[0] }, b: even(ids.slice(1), "col") };
}

/** Terminal replies to the shell's questions (cursor position, device attributes, focus), as opposed to keys
 *  the user typed. Synced panes get only typed keys: a reply sent to the wrong shell shows up as garbage. */
export const isReply = (data: string) => /^\x1b\[(\??[\d;]*[Rc]|[IO])$/.test(data);
