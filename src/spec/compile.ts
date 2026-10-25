import { LANES, type EntryPoint } from '../analyze/spring.js';
import type { Canvas } from '../canvas/canvas.js';
import { COLORS, Graph, type GEdge } from '../canvas/graph.js';
import type { EdgeKind, Fact, FactsIndex } from '../facts/index.js';
import { layoutGraph } from '../layout/elk.js';
import { ICONS, type Role } from '../theme/index.js';
import { entryIcon, link, methodLabel, safe, sourceLink, type Editor } from '../views/context.js';
import type { ViewSpec } from './schema.js';
import { resolve } from './select.js';

export interface CompileOptions {
  editor?: Editor;
  /** Reject unknown ids, empty selectors and oversized views instead of only warning. */
  strict?: boolean;
  /** Whether a canvas path exists in the output directory (for links to the generated flow canvases). */
  exists?: (rel: string) => boolean;
}

export interface CompileResult {
  graph: Graph;
  nodes: number;
  errors: string[];
  warnings: string[];
}

/** Left-to-right reading order shared by every view: triggers, inbound, logic, adapters, infrastructure, model. */
const ORDER: Record<string, number> = { entry: 0, inbound: 1, service: 2, outbound: 3, kafka: 4, dlt: 4, db: 4, llm: 4, http: 4, vector: 4, model: 5, config: 5, other: 5 };

/** Pure: the same spec and facts always give the same graph. */
export function compileSpec(spec: ViewSpec, facts: FactsIndex, opts: CompileOptions = {}): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inc = resolve(facts, spec.include);
  const exc = resolve(facts, spec.exclude);
  for (const id of inc.unknown) errors.push(`unknown id ${id}${suggest(facts, id)}`);
  for (const s of inc.empty) (opts.strict ? errors : warnings).push(`include selector matched nothing: ${s}`);

  const ids = [...inc.ids].filter((id) => !exc.ids.has(id)).sort();
  const shown = new Set(ids);
  if (ids.length > spec.maxNodes) errors.push(`view has ${ids.length} nodes, more than maxNodes ${spec.maxNodes}; narrow the selectors or raise maxNodes`);
  if (!ids.length) errors.push('view is empty');

  const explicit = spec.groups.map((g) => ({ ...g, ids: resolve(facts, g.members).ids }));
  for (const id of Object.keys(spec.annotations)) if (!shown.has(id)) warnings.push(`annotation for ${id}, which is not in the view`);
  for (const n of spec.notes) if (n.attach && !shown.has(n.attach)) warnings.push(`note attached to ${n.attach}, which is not in the view`);

  const byClass = spec.groupBy.includes('class');
  // A shown type with shown methods becomes the group around them instead of a box of its own.
  const classGroups = new Set(byClass ? ids.filter((id) => facts.get(id)!.kind === 'method').map((id) => facts.get(id)!.owner!).filter((t) => shown.has(t)) : []);

  const g = new Graph(spec.direction);
  const groupOf = new Map<string, string>();

  const levelKey = (level: string, f: Fact): { key: string; label: string; color?: string } | undefined => {
    const memberOf = f.kind === 'method' || f.kind === 'type';
    switch (level) {
      case 'module':
        return f.module ? { key: `module:${f.module}`, label: `📦 ${f.module}` } : undefined;
      case 'package':
        return f.pkg ? { key: `pkg:${f.pkg}`, label: f.pkg } : undefined;
      case 'lane':
        return memberOf ? { key: `lane:${f.role}`, label: LANES.find((l) => l.id === f.role)?.title ?? f.role, color: COLORS[f.role as Role] } : undefined;
      case 'class': {
        const typeFactId = f.kind === 'method' ? f.owner! : f.kind === 'type' && classGroups.has(f.id) ? f.id : undefined;
        if (!typeFactId) return undefined;
        const t = facts.get(typeFactId)!;
        const a = spec.annotations[typeFactId];
        const label = `${a?.emphasis === 'highlight' ? `${ICONS.highlight} ` : ''}${a?.label ?? `${t.name} · ${t.detail}`}`;
        return { key: `class:${typeFactId}`, label, color: color(spec, typeFactId, COLORS[t.role as Role] ?? COLORS.other) };
      }
      default: {
        const grp = explicit.find((x) => x.id === level.slice('group:'.length));
        return grp ? { key: level, label: grp.label } : undefined;
      }
    }
  };
  const place = (f: Fact): string | undefined => {
    const grp = explicit.find((x) => x.ids.has(f.id) || (f.owner && x.ids.has(f.owner)));
    const levels = grp ? [`group:${grp.id}`, ...(byClass ? ['class'] : [])] : spec.groupBy;
    let parent: string | undefined;
    for (const level of levels) {
      const k = levelKey(level, f);
      if (!k) continue;
      const gid = parent ? `${parent}/${k.key}` : k.key;
      g.group({ id: gid, label: k.label, color: k.color, parent, partition: parent ? undefined : ORDER[f.kind === 'entry' ? 'entry' : f.role] });
      parent = gid;
    }
    return parent;
  };

  const flowPath = (e: EntryPoint) => `flows/${safe(e.id)}.flow.canvas`;
  for (const id of ids) {
    const f = facts.get(id)!;
    const parent = place(f);
    if (classGroups.has(id)) {
      groupOf.set(id, parent!);
      // A class drawn as a group has no text of its own, so its note becomes a box inside it.
      const note = spec.annotations[id]?.note;
      if (note) g.node({ id: `note:${id}`, text: `> ${note}`, parent });
      continue;
    }
    const base = f.kind === 'entry' ? COLORS.entry : COLORS[f.role as Role] ?? COLORS.other;
    g.node({ id, text: decorate(spec, id, nodeText(facts, f, spec, opts, flowPath)), color: color(spec, id, base), parent, partition: parent ? undefined : ORDER[f.kind === 'entry' ? 'entry' : f.role] });
  }

  // Edges whose endpoints are hidden are lifted to the nearest shown owner (method → class, entry → method).
  const visible = (id: string): string | undefined => {
    for (let cur: string | undefined = id; cur; cur = facts.get(cur)?.owner) {
      if (shown.has(cur)) return groupOf.get(cur) ?? cur;
    }
    return undefined;
  };
  const lifted = new Map<string, { e: GEdge; n: number }>();
  for (const e of facts.edges) {
    if (!spec.edges.includes(e.kind)) continue;
    const from = visible(e.from);
    const to = visible(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}>${e.kind}`;
    const hit = lifted.get(key);
    if (hit) hit.n++;
    else lifted.set(key, { e: { from, to, label: edgeLabel(e.kind, e.label), color: edgeColor(facts, e.kind, e.to) }, n: 1 });
  }
  for (const key of [...lifted.keys()].sort()) {
    const { e, n } = lifted.get(key)!;
    g.edge(n > 1 ? { ...e, label: [e.label, `×${n}`].filter(Boolean).join(' ') } : e);
  }

  spec.notes.forEach((n, i) => {
    const id = `note:${i}`;
    g.node({ id, text: n.text });
    const target = n.attach && visible(n.attach);
    if (target) g.edge({ from: id, to: target, undirected: true, color: COLORS.config });
  });

  return { graph: g, nodes: ids.length, errors, warnings };
}

export async function compileView(spec: ViewSpec, facts: FactsIndex, opts: CompileOptions = {}): Promise<{ canvas?: Canvas } & Omit<CompileResult, 'graph'>> {
  const { graph, ...rest } = compileSpec(spec, facts, opts);
  if (rest.errors.length) return rest;
  return { ...rest, canvas: await layoutGraph(graph, `view:${spec.name}`, { layerSpacing: 110 }) };
}

function nodeText(facts: FactsIndex, f: Fact, spec: ViewSpec, opts: CompileOptions, flowPath: (e: EntryPoint) => string): string {
  const ed = { editor: opts.editor ?? 'vscode' };
  const mid = spec.detail !== 'low';
  const high = spec.detail === 'high';
  const lines: string[] = [];
  switch (f.kind) {
    case 'method': {
      const m = facts.methods.get(f.id)!;
      const owner = spec.groupBy.includes('class') ? '' : `${m.owner.name}.`;
      lines.push(`**${owner}${methodLabel(m)}**`);
      if (mid && !m.isConstructor && m.returnType !== 'void') lines.push(`→ \`${m.returnType}\``);
      if (high && m.annotations.length) lines.push(m.annotations.map((a) => `\`@${a.name}\``).join(' '));
      if (mid) lines.push(sourceLink(ed, m.owner, m.line));
      break;
    }
    case 'type': {
      const t = facts.types.get(f.id)!;
      lines.push(`### ${t.name}`, `_${f.detail}_`);
      if (high) lines.push(`${t.methods.filter((m) => !m.isConstructor).length} methods · ${t.fields.length} fields`);
      if (mid) lines.push(sourceLink(ed, t, t.line));
      break;
    }
    case 'entry': {
      const e = facts.entries.get(f.id)!;
      lines.push(`# ${entryIcon(e)} ${e.trigger}`);
      if (mid) lines.push(`${e.method.owner.name}.${e.method.name}()`);
      if (high && e.detail) lines.push(`_${e.detail}_`);
      if (mid && opts.exists?.(flowPath(e))) lines.push(link(flowPath(e), 'call flow →'));
      break;
    }
    case 'topic':
      lines.push(`## ${f.role === 'dlt' ? ICONS.dlt : ICONS.kafka} ${f.name}`);
      if (mid && f.detail) lines.push(...f.detail.split(' · '));
      break;
    case 'external':
      lines.push(`### ${ICONS[f.role as keyof typeof ICONS] ?? ''} ${f.name}`.replace('###  ', '### '));
      if (mid && f.detail) lines.push(...f.detail.split(' · '));
      break;
  }
  return lines.join('\n');
}

/** Applies a spec annotation: label replaces the headline (keeping its markdown level), note is appended. */
function decorate(spec: ViewSpec, id: string, text: string): string {
  const a = spec.annotations[id];
  if (!a) return text;
  const [first, ...rest] = text.split('\n');
  let head = first;
  if (a.label) head = /^#+ /.test(first) ? `${first.match(/^#+ /)![0]}${a.label}` : `**${a.label}**`;
  if (a.emphasis === 'highlight') head = head.replace(/^(#+ |\*\*)?/, (p) => `${p ?? ''}${ICONS.highlight} `);
  return [head, ...rest, ...(a.note ? [`> ${a.note}`] : [])].join('\n');
}

function color(spec: ViewSpec, id: string, base: string): string {
  return spec.annotations[id]?.emphasis === 'muted' ? COLORS.other : base;
}

function edgeLabel(kind: EdgeKind, label?: string): string | undefined {
  switch (kind) {
    case 'calls':
    case 'triggers':
      return undefined;
    case 'injects':
    case 'extends':
      return kind;
    default:
      return label;
  }
}

function edgeColor(facts: FactsIndex, kind: EdgeKind, to: string): string | undefined {
  switch (kind) {
    case 'produces':
    case 'consumes':
      return COLORS.kafka;
    case 'uses':
      return COLORS[facts.get(to)?.role as Role] ?? COLORS.other;
    case 'extends':
      return COLORS.config;
    case 'injects':
      return COLORS.other;
    default:
      return undefined;
  }
}

/** Closest existing ids by edit distance, for typos and renamed symbols. */
function suggest(facts: FactsIndex, id: string): string {
  const prefix = id.slice(0, id.indexOf(':') + 1);
  const hits = [...facts.facts.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => ({ k, d: distance(k, id) }))
    .filter((x) => x.d <= Math.max(3, id.length / 4))
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, 3);
  return hits.length ? ` (did you mean ${hits.map((h) => h.k).join(', ')}?)` : '';
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
