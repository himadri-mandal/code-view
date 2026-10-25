import { buildCfg, type CfgNode } from '../analyze/cfg.js';
import type { Canvas } from '../canvas/canvas.js';
import { COLORS, Graph, measure } from '../canvas/graph.js';
import { layoutGraph } from '../layout/elk.js';
import type { MethodDecl } from '../model.js';
import { entriesOf, entryIcon, link, methodLabel, sourceLink, type ViewContext } from './context.js';

const KIND_COLOR: Partial<Record<CfgNode['kind'], string>> = {
  start: COLORS.terminal,
  end: COLORS.terminal,
  decision: COLORS.decision,
  loop: COLORS.loop,
  return: COLORS.terminal,
  throw: COLORS.error,
  try: COLORS.other,
  catch: COLORS.error,
  finally: COLORS.other,
};

/** L3: statement-level flowchart of one method. */
export async function methodCanvas(ctx: ViewContext, m: MethodDecl): Promise<Canvas> {
  const cfg = buildCfg(m);
  const g = new Graph('DOWN');
  const outgoing = ctx.calls.outgoing(m);

  const header = [
    `# ${m.owner.name}.${methodLabel(m)}`,
    sourceLink(ctx, m.owner, m.line),
    ...entriesOf(ctx, m).map((e) => `${entryIcon(e)} ${link(ctx.paths.flow(e), `${e.trigger} — call flow`)}`),
    link(ctx.paths.component(m.owner.module), '← components'),
  ].join('\n');
  g.node({ id: 'header', text: header });

  for (const n of cfg.nodes) {
    const calls = outgoing.filter(({ call }) => n.stmts.some((s) => call.node.startIndex >= s.startIndex && call.node.endIndex <= s.endIndex));
    const refs = new Set<string>();
    for (const { target } of calls) {
      if (target.kind === 'method') refs.add(`↳ ${ctx.cfgMethods.has(target.method) ? link(ctx.paths.method(target.method), `${target.method.owner.name}.${target.method.name}()`) : `${target.method.owner.name}.${target.method.name}()`}`);
      else if (target.kind === 'external') refs.add(`⇢ ${target.system.label}: ${target.action}`);
      else if (target.kind === 'topic') refs.add(`📨 send → ${target.topic}`);
      else refs.add(`📣 publish ${target.event}`);
    }
    const text = nodeText(n, [...refs]);
    const color = KIND_COLOR[n.kind] ?? (refs.size ? COLORS.call : undefined);
    g.node({ id: n.id, text, color, ...measure(text, n.kind === 'start' || n.kind === 'end' ? 140 : 200, 560) });
  }
  g.edge({ from: 'header', to: 'n0', undirected: true });
  for (const e of cfg.edges) g.edge({ from: e.from, to: e.to, label: e.label, back: e.back, color: e.back ? COLORS.loop : e.label === 'throws' ? COLORS.error : undefined });
  return layoutGraph(g, `method:${m.id}`, { spacing: 50, layerSpacing: 60 });
}

function nodeText(n: CfgNode, refs: string[]): string {
  switch (n.kind) {
    case 'start':
      return `▶ **${n.lines[0]}**`;
    case 'end':
      return '■ end';
    case 'decision':
      return `◆ **${escape(n.lines[0])}**${refs.length ? `\n${refs.join('\n')}` : ''}`;
    case 'loop':
      return `↻ **${escape(n.lines[0])}**${refs.length ? `\n${refs.join('\n')}` : ''}`;
    default:
      return ['```java', ...n.lines, '```', ...refs].join('\n');
  }
}

function escape(s: string): string {
  return s.replace(/([*_`[\]])/g, '\\$1');
}
