import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Canvas, CanvasNode } from '../src/canvas/canvas.js';

export const FIXTURES = path.resolve(__dirname, 'fixtures');
export const hasFixture = (name: string) => fs.existsSync(path.join(FIXTURES, name, 'src')) || fs.existsSync(path.join(FIXTURES, name, 'pom.xml'));
export const tmpOut = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `java-canvas-${name}-`));

export function readCanvas(dir: string, rel: string): Canvas {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

export function texts(c: Canvas): string[] {
  return c.nodes.map((n: CanvasNode) => (n.type === 'text' ? n.text : n.type === 'group' ? (n.label ?? '') : ''));
}

/** Edges as "fromFirstLine -> toFirstLine | label" for readable assertions. */
export function edgeList(c: Canvas): string[] {
  const first = (id: string) => {
    const n = c.nodes.find((x) => x.id === id)!;
    return (n.type === 'text' ? n.text : n.type === 'group' ? n.label ?? '' : '').split('\n')[0];
  };
  return c.edges.map((e) => `${first(e.fromNode)} -> ${first(e.toNode)} | ${e.label ?? ''}`);
}
