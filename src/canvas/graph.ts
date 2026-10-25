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

/** Palette (hex so we are not limited to the six presets). */
export const COLORS = {
  inbound: '#3b82f6',
  service: '#22c55e',
  outbound: '#f97316',
  model: '#eab308',
  config: '#94a3b8',
  other: '#a1a1aa',
  kafka: '#a855f7',
  dlt: '#ef4444',
  llm: '#ec4899',
  db: '#f97316',
  http: '#14b8a6',
  vector: '#d946ef',
  decision: '#eab308',
  loop: '#06b6d4',
  terminal: '#64748b',
  error: '#ef4444',
  call: '#22c55e',
  entry: '#3b82f6',
} as const;

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
