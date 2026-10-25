import type { Canvas, CanvasNode } from '../canvas/canvas.js';
import { sides, type Box } from './elk.js';

const PAD = { top: 60, left: 30, bottom: 30, right: 30 };
const GAP = 40;

export interface ChangeReport {
  added: string[];
  removed: string[];
  changed: string[];
  /** Nodes that kept the position from the previous canvas. */
  kept: number;
}

/**
 * Keeps a re-rendered canvas visually stable: nodes that existed in `prev` (same id) keep their position,
 * new nodes are placed next to an existing neighbour from the fresh layout, and groups are refitted around
 * their members. Without anchored nodes the fresh layout is returned unchanged.
 */
export function anchorCanvas(fresh: Canvas, prev: Canvas | undefined): { canvas: Canvas; report: ChangeReport } {
  const report = diff(fresh, prev);
  if (!prev) return { canvas: fresh, report };
  const before = new Map(prev.nodes.filter((n) => n.type !== 'group').map((n) => [n.id, n]));
  const leaves = fresh.nodes.filter((n) => n.type !== 'group');
  const groups = fresh.nodes.filter((n) => n.type === 'group');
  if (!leaves.some((n) => before.has(n.id))) return { canvas: fresh, report };

  const parent = containment(fresh.nodes);
  const prevParent = containment(prev.nodes);
  const placed = new Map<string, Box>();
  for (const n of leaves) {
    const p = before.get(n.id);
    if (p) placed.set(n.id, { x: p.x, y: p.y, width: n.width, height: n.height });
  }
  report.kept = placed.size;

  const neighbours = new Map<string, string[]>();
  for (const e of fresh.edges) {
    neighbours.set(e.fromNode, [...(neighbours.get(e.fromNode) ?? []), e.toNode]);
    neighbours.set(e.toNode, [...(neighbours.get(e.toNode) ?? []), e.fromNode]);
  }
  const anchors = leaves.filter((n) => placed.has(n.id));
  for (const n of leaves) {
    if (placed.has(n.id)) continue;
    const dist = (m: CanvasNode) => Math.hypot(m.x - n.x, m.y - n.y);
    const nearest = (list: CanvasNode[]) => [...list].sort((a, b) => dist(a) - dist(b) || a.id.localeCompare(b.id))[0];
    const ref =
      nearest(anchors.filter((m) => parent.get(m.id) === parent.get(n.id) && parent.get(n.id))) ??
      nearest(anchors.filter((m) => neighbours.get(n.id)?.includes(m.id))) ??
      nearest(anchors);
    const r = placed.get(ref.id)!;
    const box = { x: r.x + n.x - ref.x, y: r.y + n.y - ref.y, width: n.width, height: n.height };
    for (let i = 0; i < 500; i++) {
      const hit = [...placed.values()].find((b) => overlaps(b, box));
      if (!hit) break;
      box.y = hit.y + hit.height + GAP;
    }
    placed.set(n.id, box);
  }

  // Refit groups around their members, innermost first.
  const depth = (id: string) => {
    let d = 0;
    for (let p = parent.get(id); p; p = parent.get(p)) d++;
    return d;
  };
  const prevGroups = new Map(prev.nodes.filter((n) => n.type === 'group').map((n) => [n.id, n]));
  for (const grp of [...groups].sort((a, b) => depth(b.id) - depth(a.id) || a.id.localeCompare(b.id))) {
    const members = [...fresh.nodes].filter((m) => parent.get(m.id) === grp.id).map((m) => placed.get(m.id)).filter((b): b is Box => !!b);
    const old = prevGroups.get(grp.id);
    const memberIds = fresh.nodes.filter((m) => parent.get(m.id) === grp.id).map((m) => m.id).sort();
    const prevIds = prev.nodes.filter((m) => prevParent.get(m.id) === grp.id).map((m) => m.id).sort();
    const prevBox = new Map(prev.nodes.map((m) => [m.id, m]));
    const same = (b: Box | undefined, o: Box | undefined) => !!b && !!o && b.x === o.x && b.y === o.y && b.width === o.width && b.height === o.height;
    // A group whose members did not change at all keeps its previous box exactly.
    if (old && memberIds.join() === prevIds.join() && memberIds.every((m) => same(placed.get(m), prevBox.get(m)))) {
      placed.set(grp.id, { x: old.x, y: old.y, width: old.width, height: old.height });
      continue;
    }
    if (!members.length) {
      placed.set(grp.id, old ? { x: old.x, y: old.y, width: grp.width, height: grp.height } : { x: grp.x, y: grp.y, width: grp.width, height: grp.height });
      continue;
    }
    const x = Math.min(...members.map((b) => b.x)) - PAD.left;
    const y = Math.min(...members.map((b) => b.y)) - PAD.top;
    const right = Math.max(...members.map((b) => b.x + b.width)) + PAD.right;
    const bottom = Math.max(...members.map((b) => b.y + b.height)) + PAD.bottom;
    // Never narrower than the fresh layout made it, which accounts for the label.
    placed.set(grp.id, { x, y, width: Math.max(right - x, grp.width), height: bottom - y });
  }

  const nodes = fresh.nodes.map((n) => ({ ...n, ...placed.get(n.id)! }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const down = fresh.edges.filter((e) => e.fromSide === 'bottom' && e.toSide === 'top').length > fresh.edges.filter((e) => e.fromSide === 'right').length;
  const edges = fresh.edges.map((e) => {
    // Loop-back edges use the same side at both ends; keep them as drawn.
    if (e.fromSide && e.fromSide === e.toSide) return e;
    const [fromSide, toSide] = sides(byId.get(e.fromNode)!, byId.get(e.toNode)!, down ? 'DOWN' : 'RIGHT');
    return { ...e, fromSide, toSide };
  });
  return { canvas: { nodes, edges }, report };
}

/** Innermost group containing each node, judged from the fresh layout. */
function containment(nodes: CanvasNode[]): Map<string, string> {
  const groups = nodes.filter((n) => n.type === 'group').sort((a, b) => a.width * a.height - b.width * b.height);
  const out = new Map<string, string>();
  for (const n of nodes) {
    const g = groups.find((g) => g.id !== n.id && g.width * g.height > n.width * n.height && inside(n, g));
    if (g) out.set(n.id, g.id);
  }
  return out;
}

function inside(a: Box, b: Box): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width + GAP / 2 && b.x < a.x + a.width + GAP / 2 && a.y < b.y + b.height + GAP / 2 && b.y < a.y + a.height + GAP / 2;
}

function headline(n: CanvasNode): string {
  if (n.type === 'group') return `[${n.label ?? ''}]`;
  if (n.type === 'text') return n.text.split('\n')[0].replace(/^#+\s*|\*\*/g, '');
  return n.type === 'file' ? n.file : n.url;
}

function diff(fresh: Canvas, prev: Canvas | undefined): ChangeReport {
  const old = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const now = new Set(fresh.nodes.map((n) => n.id));
  const text = (n: CanvasNode) => (n.type === 'text' ? n.text : n.type === 'group' ? n.label ?? '' : '');
  return {
    added: fresh.nodes.filter((n) => !old.has(n.id)).map(headline),
    removed: (prev?.nodes ?? []).filter((n) => !now.has(n.id)).map(headline),
    changed: fresh.nodes.filter((n) => old.has(n.id) && (text(old.get(n.id)!) !== text(n) || old.get(n.id)!.color !== n.color)).map(headline),
    kept: 0,
  };
}
