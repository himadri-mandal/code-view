import ELKModule from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { stableId, type Canvas, type CanvasEdge, type CanvasNode, type Side } from '../canvas/canvas.js';
import { measure, type Graph } from '../canvas/graph.js';

const ELK = ELKModule as unknown as new () => { layout(g: ElkNode): Promise<ElkNode> };
const elk = new ELK();
const GROUP_PADDING = '[top=60,left=30,bottom=30,right=30]';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Lays out a graph with ELK's layered algorithm (groups become compound nodes) and emits a canvas. */
export async function layoutGraph(g: Graph, name: string, opts: { spacing?: number; layerSpacing?: number } = {}): Promise<Canvas> {
  const byId = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: '__root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': g.direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': String(opts.spacing ?? 40),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.layerSpacing ?? 90),
      'elk.spacing.edgeNode': '30',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.partitioning.activate': String([...g.nodes, ...g.groups].some((n) => n.partition !== undefined)),
    },
    children: [],
    edges: [],
  };
  byId.set(root.id, root);
  for (const grp of g.groups) {
    byId.set(grp.id, {
      id: grp.id,
      children: [],
      layoutOptions: {
        'elk.padding': GROUP_PADDING,
        ...(grp.partition !== undefined ? { 'elk.partitioning.partition': String(grp.partition) } : {}),
      },
    });
  }
  for (const n of g.nodes) {
    const size = n.width && n.height ? { width: n.width, height: n.height } : measure(n.text);
    byId.set(n.id, {
      id: n.id,
      ...size,
      layoutOptions: n.partition !== undefined ? { 'elk.partitioning.partition': String(n.partition) } : undefined,
    });
  }
  for (const item of [...g.groups, ...g.nodes]) {
    const parent = (item.parent && byId.get(item.parent)) || root;
    parent.children!.push(byId.get(item.id)!);
  }
  root.edges = g.edges
    .filter((e) => !e.back && byId.has(e.from) && byId.has(e.to))
    .map((e, i): ElkExtendedEdge => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
  // Groups that ended up empty would collapse to zero size.
  for (const grp of g.groups) {
    const n = byId.get(grp.id)!;
    if (!n.children!.length) Object.assign(n, measure(grp.label));
  }

  const laid = await elk.layout(root);
  const boxes = new Map<string, Box>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const box = { x: Math.round(ox + (c.x ?? 0)), y: Math.round(oy + (c.y ?? 0)), width: Math.round(c.width ?? 100), height: Math.round(c.height ?? 60) };
      boxes.set(c.id, box);
      walk(c, box.x, box.y);
    }
  };
  walk(laid, 0, 0);
  return toCanvas(g, name, boxes);
}

/** Emits a canvas for a graph whose boxes were computed elsewhere (e.g. a grid layout). */
export function toCanvas(g: Graph, name: string, boxes: Map<string, Box>): Canvas {
  const id = (k: string) => stableId(name, k);
  const depth = (gid?: string): number => {
    let d = 0;
    for (let p = gid; p; p = g.groups.find((x) => x.id === p)?.parent) d++;
    return d;
  };
  const nodes: CanvasNode[] = [];
  for (const grp of [...g.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
    const b = boxes.get(grp.id);
    if (b) nodes.push({ id: id(grp.id), type: 'group', label: grp.label, ...b, ...(grp.color ? { color: grp.color } : {}) });
  }
  for (const n of g.nodes) {
    const b = boxes.get(n.id);
    if (b) nodes.push({ id: id(n.id), type: 'text', text: n.text, ...b, ...(n.color ? { color: n.color } : {}) });
  }
  const edges: CanvasEdge[] = [];
  g.edges.forEach((e, i) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return;
    const [fromSide, toSide] = e.back ? backSides(g.direction) : sides(a, b, g.direction);
    edges.push({
      id: id(`edge:${i}:${e.from}>${e.to}`),
      fromNode: id(e.from),
      fromSide,
      toNode: id(e.to),
      toSide,
      ...(e.undirected ? { toEnd: 'none' as const } : {}),
      ...(e.color ? { color: e.color } : {}),
      ...(e.label ? { label: e.label } : {}),
    });
  });
  return { nodes, edges };
}

function sides(a: Box, b: Box, dir: 'RIGHT' | 'DOWN'): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  const horizontalGap = b.x >= a.x + a.width || a.x >= b.x + b.width;
  const verticalGap = b.y >= a.y + a.height || a.y >= b.y + b.height;
  const horizontal = dir === 'RIGHT' ? horizontalGap || !verticalGap : !verticalGap && horizontalGap;
  if (horizontal) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function backSides(dir: 'RIGHT' | 'DOWN'): [Side, Side] {
  return dir === 'DOWN' ? ['left', 'left'] : ['bottom', 'bottom'];
}
