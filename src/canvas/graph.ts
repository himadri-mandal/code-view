import type { CanvasColor } from './canvas.js';

/** Layout-independent diagram description; ids are logical keys (hashed when emitted). */
export interface GNode {
  id: string;
  text: string;
  color?: CanvasColor;
  parent?: string;
  width?: number;
  height?: number;
  /** Column hint for layered layouts (lower = further left/top). */
  partition?: number;
}

export interface GGroup {
  id: string;
  label: string;
  color?: CanvasColor;
  parent?: string;
  partition?: number;
}

export interface GEdge {
  from: string;
  to: string;
  label?: string;
  color?: CanvasColor;
  /** Edges that go against the layout direction (loops); excluded from layering. */
  back?: boolean;
  undirected?: boolean;
}

export class Graph {
  readonly nodes: GNode[] = [];
  readonly groups: GGroup[] = [];
  readonly edges: GEdge[] = [];

  constructor(readonly direction: 'RIGHT' | 'DOWN' = 'RIGHT') {}

  has(id: string): boolean {
    return this.nodes.some((n) => n.id === id) || this.groups.some((g) => g.id === id);
  }

  node(n: GNode): string {
    if (!this.has(n.id)) this.nodes.push(n);
    return n.id;
  }

  group(g: GGroup): string {
    if (!this.has(g.id)) this.groups.push(g);
    return g.id;
  }

  edge(e: GEdge): void {
    if (e.from === e.to && !e.back) return;
    const dup = this.edges.find((x) => x.from === e.from && x.to === e.to && x.label === e.label);
    if (!dup) this.edges.push(e);
  }
}

export { COLORS } from '../theme/index.js';

const LINK = /\[\[[^\]|]*\|([^\]]*)\]\]|\[\[([^\]]*)\]\]|\[([^\]]*)\]\([^)]*\)/g;

/** Estimates the rendered size of a markdown text node. */
export function measure(text: string, minW = 180, maxW = 520): { width: number; height: number } {
  const lines = text.split('\n').map((l) => l.replace(LINK, (_m, a, b, c) => a ?? b ?? c ?? '').replace(/[*_`]/g, ''));
  const charW = 7.6;
  const longest = Math.max(...lines.map((l) => l.replace(/^#+\s*/, '').length * (l.startsWith('#') ? 1.25 : 1)));
  const width = Math.round(Math.min(maxW, Math.max(minW, longest * charW + 48)));
  const perLine = Math.max(1, Math.floor((width - 48) / charW));
  let height = 36;
  for (const l of lines) {
    const heading = /^#{1,3}\s/.test(l);
    const rows = Math.max(1, Math.ceil(l.length / perLine));
    height += rows * (heading ? 34 : 24);
  }
  return { width, height: Math.round(height) };
}
