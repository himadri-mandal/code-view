import type { Flow, FlowStep } from '../analyze/callgraph.js';
import type { EntryPoint } from '../analyze/spring.js';
import type { Canvas } from '../canvas/canvas.js';
import { COLORS, Graph } from '../canvas/graph.js';
import { layoutGraph } from '../layout/elk.js';
import type { MethodDecl, TypeDecl } from '../model.js';
import { entriesOf, entryIcon, link, methodLabel, sourceLink, type ViewContext } from './context.js';

/** L2: call flow from one entry point, one group per class, numbered calls, async hops to topics. */
export async function flowCanvas(ctx: ViewContext, flow: Flow): Promise<Canvas> {
  const g = new Graph('RIGHT');
  const { entry } = flow;
  const trigger = 'trigger';
  g.node({ id: trigger, text: triggerText(ctx, entry), color: COLORS.entry });

  const methodId = (m: MethodDecl) => `m:${m.id}`;
  const addMethod = (m: MethodDecl) => {
    const owner = outer(m.owner);
    const info = ctx.spring.info(owner.fqn);
    const gid = `class:${owner.fqn}`;
    g.group({ id: gid, label: `${owner.name}${info ? ` · ${info.stereotype}` : ''}`, color: COLORS[info?.lane ?? 'other'] });
    const other = entriesOf(ctx, m).filter((e) => e !== entry);
    const text = [
      `**${methodLabel(m)}**${m.body ? '' : ' _(abstract)_'}`,
      m.returnType !== 'void' && !m.isConstructor ? `→ \`${m.returnType}\`` : '',
      [sourceLink(ctx, m.owner, m.line), ctx.cfgMethods.has(m) ? link(ctx.paths.method(m), 'flowchart') : ''].filter(Boolean).join(' · '),
      ...other.map((e) => `${entryIcon(e)} also ${link(ctx.paths.flow(e), e.trigger)}`),
    ].filter(Boolean).join('\n');
    g.node({ id: methodId(m), text, parent: gid });
  };
  for (const m of flow.methods) addMethod(m);
  g.edge({ from: trigger, to: methodId(entry.method) });

  let usesLlm = false;
  for (const step of flow.steps) {
    const to = targetNode(ctx, g, step);
    if (step.to.kind === 'external' && step.to.system.kind === 'llm') usesLlm = true;
    g.edge({ from: methodId(step.from), to, label: stepLabel(step), color: edgeColor(step), back: step.revisit });
  }
  if (usesLlm && ctx.externals.tools.length) {
    const tools = ctx.spring.entries.filter((e) => e.kind === 'llm-tool');
    const text = ['### 🤖 Tools the LLM may call', ...tools.map((e) => `- ${link(ctx.paths.flow(e), `${e.method.owner.name}.${e.method.name}`)}`)].join('\n');
    g.node({ id: 'tools', text, color: COLORS.llm });
    g.edge({ from: 'sys:llm', to: 'tools', label: 'function calling', color: COLORS.llm });
  }
  if (flow.truncated) {
    g.node({ id: 'truncated', text: '⚠️ Depth / size limit reached.\nRe-run with a larger `--depth` to expand further.', color: COLORS.error });
  }
  return layoutGraph(g, `flow:${entry.id}`, { layerSpacing: 110 });
}

function targetNode(ctx: ViewContext, g: Graph, step: FlowStep): string {
  const t = step.to;
  switch (t.kind) {
    case 'method':
      return `m:${t.method.id}`;
    case 'external': {
      const icon = { db: '🗄', llm: '🧠', vector: '🧭', http: '🔗', kafka: '📨' }[t.system.kind];
      return g.node({ id: `sys:${t.system.id}`, text: [`### ${icon} ${t.system.label}`, ...t.system.details.filter(Boolean)].join('\n'), color: COLORS[t.system.kind] });
    }
    case 'topic': {
      const info = ctx.kafka.topics.get(t.topic);
      const text = [
        `### 📨 ${t.topic}`,
        '_async — continues in:_',
        ...(t.consumers.length ? t.consumers.map((e) => `- ${link(ctx.paths.flow(e), `${e.method.owner.name}.${e.method.name}`)}`) : ['- no consumer in this project']),
        info ? link(ctx.paths.events, 'event map') : '',
      ].filter(Boolean).join('\n');
      return g.node({ id: `topic:${t.topic}`, text, color: COLORS.kafka });
    }
    case 'event': {
      const text = [
        `### 📣 ${t.event}`,
        '_Spring event — handled by:_',
        ...(t.listeners.length ? t.listeners.map((e) => `- ${link(ctx.paths.flow(e), `${e.method.owner.name}.${e.method.name}`)}`) : ['- no listener found']),
      ].join('\n');
      return g.node({ id: `event:${t.event}`, text, color: COLORS.kafka });
    }
  }
}

function stepLabel(step: FlowStep): string {
  const parts = [`${step.seq}`];
  if (step.to.kind === 'external') parts.push(step.to.action);
  if (step.to.kind === 'topic') parts.push('send');
  if (step.to.kind === 'event') parts.push('publish');
  if (step.revisit) parts.push('↺');
  if (step.context) parts.push(`[${step.context}]`);
  return parts.join(' ');
}

function edgeColor(step: FlowStep): string | undefined {
  if (step.to.kind === 'topic' || step.to.kind === 'event') return COLORS.kafka;
  if (step.to.kind === 'external') return COLORS[step.to.system.kind];
  return undefined;
}

function triggerText(ctx: ViewContext, e: EntryPoint): string {
  const m = e.method;
  const lines = [`# ${entryIcon(e)} ${e.trigger}`, `${m.owner.name}.${m.name}()`];
  if (e.kind === 'kafka') {
    const topics = ctx.kafka.consumers.filter((c) => c.method === m).map((c) => c.topic);
    if (topics.length) lines.push(`topics: ${topics.join(', ')}`);
  }
  if (e.detail) lines.push(`> ${e.detail.length > 160 ? `${e.detail.slice(0, 159)}…` : e.detail}`);
  lines.push(`${link(ctx.paths.index, '← overview')} · ${link(ctx.paths.component(m.owner.module), 'components')}`);
  return lines.join('\n');
}

function outer(t: TypeDecl): TypeDecl {
  let o = t;
  while (o.outer) o = o.outer;
  return o;
}
