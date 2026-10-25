import { createHash } from 'node:crypto';

/** JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/). */
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type CanvasColor = string;

interface BaseNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}
export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
}
export interface FileNode extends BaseNode {
  type: 'file';
  file: string;
  subpath?: string;
}
export interface LinkNode extends BaseNode {
  type: 'link';
  url: string;
}
export interface GroupNode extends BaseNode {
  type: 'group';
  label?: string;
}
export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toNode: string;
  toSide?: Side;
  toEnd?: 'none' | 'arrow';
  color?: CanvasColor;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function stableId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export function validateCanvas(c: Canvas): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of c.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isInteger(n[k])) errors.push(`node ${n.id} has non-integer ${k}`);
    }
    if (n.width <= 0 || n.height <= 0) errors.push(`node ${n.id} has empty size`);
    if (n.type === 'text' && typeof n.text !== 'string') errors.push(`text node ${n.id} without text`);
    if (n.color && !/^([1-6]|#[0-9a-fA-F]{6})$/.test(n.color)) errors.push(`node ${n.id} has invalid color ${n.color}`);
  }
  for (const e of c.edges) {
    if (ids.has(e.id)) errors.push(`duplicate edge id ${e.id}`);
    ids.add(e.id);
    if (!c.nodes.some((n) => n.id === e.fromNode)) errors.push(`edge ${e.id} from unknown node ${e.fromNode}`);
    if (!c.nodes.some((n) => n.id === e.toNode)) errors.push(`edge ${e.id} to unknown node ${e.toNode}`);
  }
  return errors;
}
