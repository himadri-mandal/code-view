import { LANES } from '../analyze/spring.js';
import type { Canvas } from '../canvas/canvas.js';
import { COLORS, Graph } from '../canvas/graph.js';
import { layoutGraph } from '../layout/elk.js';
import type { TypeDecl } from '../model.js';
import { entryIcon, link, sourceLink, type ViewContext } from './context.js';

const MAX_ITEMS = 14;

/** L0: modules as lane summaries, with inbound triggers on the left and external systems on the right. */
export async function indexCanvas(ctx: ViewContext): Promise<Canvas> {
  const g = new Graph('RIGHT');
  const laneOf = (t: TypeDecl) => ctx.spring.info(t.fqn)?.lane ?? 'other';
  const laneNode = (t: TypeDecl) => `lane:${t.module}:${laneOf(t)}`;

  const nav = [
    `# ${ctx.project.name}`,
    `**${ctx.project.types.size}** types · **${ctx.spring.entries.length}** entry points · **${ctx.project.modules.length}** module(s)`,
    '',
    ...ctx.project.modules.map((m) => `- ${link(ctx.paths.component(m.name), `Components: ${m.name}`)}`),
    ...(ctx.kafka.used ? [`- ${link(ctx.paths.events, 'Kafka event map')}`] : []),
    `- [[README.md|Entry point index & legend]]`,
  ].join('\n');
  g.node({ id: 'nav', text: nav, partition: 0 });

  for (const module of ctx.project.modules) {
    const mid = `module:${module.name}`;
    g.group({ id: mid, label: `📦 ${module.name}`, partition: 1 });
    const classes = [...ctx.spring.classes.values()].filter((c) => c.type.module === module.name && !c.type.outer);
    for (const lane of LANES) {
      const list = classes.filter((c) => c.lane === lane.id).map((c) => c.type.name).sort();
      if (!list.length) continue;
      const text = [
        `### ${lane.title.split(' — ')[0]}`,
        ...list.slice(0, MAX_ITEMS).map((n) => `- ${n}`),
        ...(list.length > MAX_ITEMS ? [`- … ${list.length - MAX_ITEMS} more`] : []),
        link(ctx.paths.component(module.name), 'open components →'),
      ].join('\n');
      g.node({ id: `lane:${module.name}:${lane.id}`, text, color: COLORS[lane.id], parent: mid });
    }
    // Lane → lane dependency counts.
    const counts = new Map<string, number>();
    for (const d of ctx.spring.deps.filter((d) => d.from.module === module.name)) {
      const to = ctx.table.type(d.to);
      if (!to || laneOf(d.from) === laneOf(to)) continue;
      const k = `${laneNode(d.from)}>${laneNode(to)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) {
      const [from, to] = k.split('>');
      g.edge({ from, to, label: `${n} dep${n > 1 ? 's' : ''}`, color: COLORS.other });
    }
  }

  // Inbound triggers.
  const http = ctx.spring.entries.filter((e) => e.kind === 'http');
  if (http.length) {
    const text = [
      '## 🌐 HTTP API',
      ...http.slice(0, MAX_ITEMS * 2).map((e) => `- ${link(ctx.paths.flow(e), e.trigger)}`),
      ...(http.length > MAX_ITEMS * 2 ? [`- … ${http.length - MAX_ITEMS * 2} more (see README)`] : []),
    ].join('\n');
    g.node({ id: 'in:http', text, color: COLORS.entry, partition: 0 });
    for (const lane of new Set(http.map((e) => laneNode(e.method.owner)))) g.edge({ from: 'in:http', to: lane, label: 'requests' });
  }
  for (const kind of ['schedule', 'runner', 'event'] as const) {
    const list = ctx.spring.entries.filter((e) => e.kind === kind);
    if (!list.length) continue;
    const title = { schedule: '⏰ Schedulers', runner: '🚀 Startup runners', event: '📣 Application events' }[kind];
    g.node({ id: `in:${kind}`, text: [`## ${title}`, ...list.map((e) => `- ${link(ctx.paths.flow(e), `${e.method.owner.name}.${e.method.name} — ${e.trigger}`)}`)].join('\n'), color: COLORS.entry, partition: 0 });
    for (const lane of new Set(list.map((e) => laneNode(e.method.owner)))) g.edge({ from: `in:${kind}`, to: lane });
  }

  // Kafka topics.
  for (const topic of ctx.kafka.topics.values()) {
    if (topic.role !== 'main') continue;
    const producers = ctx.kafka.producers.filter((p) => p.topic === topic.name);
    const consumers = ctx.kafka.consumers.filter((c) => c.topic === topic.name);
    const id = `topic:${topic.name}`;
    g.node({
      id,
      text: [`### 📨 ${topic.name}`, topic.payloads.size ? `payload: ${[...topic.payloads].join(', ')}` : '', link(ctx.paths.events, 'event map →')].filter(Boolean).join('\n'),
      color: COLORS.kafka,
      partition: producers.length ? 2 : 0,
    });
    for (const p of producers) g.edge({ from: laneNode(p.method.owner), to: id, label: 'produces', color: COLORS.kafka });
    for (const c of consumers) g.edge({ from: id, to: laneNode(c.method.owner), label: 'consumes', color: COLORS.kafka, back: producers.length > 0 });
  }

  // External systems.
  for (const sys of ctx.externals.systems.values()) {
    const id = `sys:${sys.id}`;
    const icon = { db: '🗄', llm: '🧠', vector: '🧭', http: '🔗', kafka: '📨' }[sys.kind];
    g.node({ id, text: [`## ${icon} ${sys.label}`, ...sys.details.filter(Boolean).map((d) => `- ${d}`)].join('\n'), color: COLORS[sys.kind], partition: 2 });
    for (const t of ctx.externals.usedBy.get(sys.id) ?? []) g.edge({ from: laneNode(outer(t)), to: id, color: COLORS[sys.kind] });
  }
  if (ctx.externals.tools.length && ctx.externals.systems.has('llm')) {
    for (const t of ctx.externals.tools) g.edge({ from: 'sys:llm', to: laneNode(t), label: 'tool calls', color: COLORS.llm, back: true });
  }
  return layoutGraph(g, 'index', { layerSpacing: 140 });
}

/** L1: producers | topics | consumers, including retry and dead-letter topics. */
export async function eventsCanvas(ctx: ViewContext): Promise<Canvas> {
  const g = new Graph('RIGHT');
  g.node({ id: 'title', text: `# Kafka event map\n${link(ctx.paths.index, '← system overview')}\nProducers → topics → consumers`, partition: 0 });
  const methodNode = (prefix: string, m: import('../model.js').MethodDecl, via: string, partition: number) => {
    const id = `${prefix}:${m.id}`;
    const entry = ctx.spring.entries.find((e) => e.method === m);
    const text = [
      `### ${m.owner.name}.${m.name}()`,
      `\`${via}\``,
      entry ? `${entryIcon(entry)} ${link(ctx.paths.flow(entry), 'call flow →')}` : '',
      sourceLink(ctx, m.owner, m.line),
    ].filter(Boolean).join('\n');
    g.node({ id, text, color: COLORS[ctx.spring.info(outer(m.owner).fqn)?.lane ?? 'other'], partition });
    return id;
  };
  for (const topic of ctx.kafka.topics.values()) {
    const id = `topic:${topic.name}`;
    const lines = [
      `## ${topic.role === 'dlt' ? '☠️' : topic.role === 'retry' ? '🔁' : '📨'} ${topic.name}`,
      topic.role !== 'main' ? `\`${topic.role}\` of ${topic.parent}` : '',
      topic.partitions ? `partitions: ${topic.partitions}${topic.replicas ? ` · replicas: ${topic.replicas}` : ''}` : '',
      topic.payloads.size ? `payload: ${[...topic.payloads].join(', ')}` : '',
      topic.groups.size ? `groups: ${[...topic.groups].join(', ')}` : '',
      topic.declaredIn ? `declared ${sourceLink(ctx, topic.declaredIn.owner, topic.declaredIn.line, `in ${topic.declaredIn.owner.name}`)}` : '',
    ];
    g.node({ id, text: lines.filter(Boolean).join('\n'), color: topic.role === 'main' ? COLORS.kafka : COLORS.dlt, partition: 1 });
    if (topic.parent) g.edge({ from: `topic:${topic.parent}`, to: id, label: topic.role === 'dlt' ? 'dead letter' : 'retry', color: COLORS.dlt });
  }
  for (const p of ctx.kafka.producers) g.edge({ from: methodNode('p', p.method, p.via, 0), to: `topic:${p.topic}`, label: p.via, color: COLORS.kafka });
  for (const c of ctx.kafka.consumers) g.edge({ from: `topic:${c.topic}`, to: methodNode('c', c.method, c.via, 2), label: c.via, color: COLORS.kafka });
  return layoutGraph(g, 'events', { layerSpacing: 160 });
}

function outer(t: TypeDecl): TypeDecl {
  let o = t;
  while (o.outer) o = o.outer;
  return o;
}

