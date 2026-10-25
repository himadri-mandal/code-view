import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Canvas } from '../canvas/canvas.js';

/** Palette (hex so we are not limited to the six presets). Every canvas colors by role from here, never ad hoc. */
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

export type Role = keyof typeof COLORS;

export const ICONS = {
  db: '🗄',
  llm: '🧠',
  vector: '🧭',
  http: '🔗',
  kafka: '📨',
  dlt: '☠️',
  retry: '🔁',
  event: '📣',
  highlight: '⭐',
} as const;

export interface Theme {
  colors: Record<Role, string>;
}

export const THEME_FILE = 'theme.yaml';

/**
 * Project theme: the default palette with overrides from `<outDir>/theme.yaml`, e.g.
 * `colors: { service: '#16a34a' }`. Unknown keys and malformed colors are ignored.
 */
export function loadTheme(outDir: string): Theme {
  const colors: Record<Role, string> = { ...COLORS };
  const file = path.join(outDir, THEME_FILE);
  if (!fs.existsSync(file)) return { colors };
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) as { colors?: Record<string, unknown> } | null;
  for (const [k, v] of Object.entries(raw?.colors ?? {})) {
    if (k in colors && typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) colors[k as Role] = v.toLowerCase();
  }
  return { colors };
}

/**
 * Re-colors a canvas built with the default palette. Roles sharing a default hex (db/outbound, dlt/error,
 * model/decision) follow whichever of them is overridden.
 */
export function applyTheme(c: Canvas, theme: Theme): Canvas {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(theme.colors)) if (COLORS[k as Role] !== v) map.set(COLORS[k as Role], v);
  if (!map.size) return c;
  const re = <T extends { color?: string }>(x: T): T => (x.color && map.has(x.color) ? { ...x, color: map.get(x.color)! } : x);
  return { nodes: c.nodes.map(re), edges: c.edges.map(re) };
}
