// Pane layout of one tab, like a tmux window: a binary tree where each leaf is a
// shell (its id is the pty id) and each split holds two children side by side
// ("row") or stacked ("col"). Pure functions, so the tree is easy to test.

export type Pane =
  | { kind: "leaf"; id: number }
  | { kind: "split"; id: number; dir: "row" | "col"; a: Pane; b: Pane };

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
