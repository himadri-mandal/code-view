import fs from 'node:fs';
import type { Lane } from '../analyze/spring.js';
import type { EntryKind, EntryPoint } from '../analyze/spring.js';
import type { analyze } from '../generate.js';
import type { MethodDecl, TypeDecl } from '../model.js';

export type Analysis = Awaited<ReturnType<typeof analyze>>;

export type FactKind = 'type' | 'method' | 'entry' | 'topic' | 'external';
export type EdgeKind = 'calls' | 'injects' | 'extends' | 'produces' | 'consumes' | 'uses' | 'triggers';
export const EDGE_KINDS: EdgeKind[] = ['calls', 'injects', 'extends', 'produces', 'consumes', 'uses', 'triggers'];

/** One addressable thing in the project. Ids are stable across runs as long as the symbol is not renamed. */
export interface Fact {
  /** `type:<fqn>`, `method:<fqn>#name(sig)`, `entry:<Class.method>`, `topic:<name>` or `ext:<system id>`. */
  id: string;
  kind: FactKind;
  /** Short display name: class name, `Class.method`, trigger, topic or system label. */
  name: string;
  /** Lane for types/methods, entry kind for entries, `kafka`/`dlt` for topics, system kind for externals. */
  role: string;
  module?: string;
  pkg?: string;
  /** Owning type id for methods, method id for entries. */
  owner?: string;
  file?: string;
  line?: number;
  endLine?: number;
  detail?: string;
}

export interface FactEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export const typeId = (t: TypeDecl) => `type:${t.fqn}`;
export const methodId = (m: MethodDecl) => `method:${m.id}`;
export const entryId = (e: EntryPoint) => `entry:${e.id}`;
export const topicId = (name: string) => `topic:${name}`;
export const extId = (id: string) => `ext:${id}`;

/** Flat, queryable view of an analysis: the vocabulary an LLM may use to describe a canvas. */
export class FactsIndex {
  readonly facts = new Map<string, Fact>();
  readonly edges: FactEdge[] = [];
  readonly types = new Map<string, TypeDecl>();
  readonly methods = new Map<string, MethodDecl>();
  readonly entries = new Map<string, EntryPoint>();
  private readonly out = new Map<string, FactEdge[]>();
  private readonly in = new Map<string, FactEdge[]>();

  constructor(readonly a: Analysis) {
    const { project, spring, kafka, externals } = a;
    const lane = (t: TypeDecl): Lane => spring.info(outermost(t).fqn)?.lane ?? 'other';

    for (const t of [...project.types.values()].sort((x, y) => x.fqn.localeCompare(y.fqn))) {
      const info = spring.info(t.fqn);
      this.types.set(typeId(t), t);
      this.add({ id: typeId(t), kind: 'type', name: t.name, role: lane(t), module: t.module, pkg: t.pkg, file: t.file, line: t.line, detail: info?.stereotype ?? t.kind });
      for (const m of t.methods) {
        this.methods.set(methodId(m), m);
        this.add({
          id: methodId(m),
          kind: 'method',
          name: `${t.name}.${m.isConstructor ? 'new' : m.name}`,
          role: lane(t),
          module: t.module,
          pkg: t.pkg,
          owner: typeId(t),
          file: t.file,
          line: m.line,
          endLine: m.endLine,
          detail: `${m.isConstructor ? t.name : m.name}(${m.params.map((p) => `${p.type} ${p.name}`).join(', ')})${m.isConstructor ? '' : `: ${m.returnType}`}`,
        });
      }
    }
    for (const e of spring.entries) {
      this.entries.set(entryId(e), e);
      const t = e.method.owner;
      this.add({ id: entryId(e), kind: 'entry', name: e.trigger, role: e.kind satisfies EntryKind, module: t.module, pkg: t.pkg, owner: methodId(e.method), file: t.file, line: e.method.line, detail: e.detail });
    }
    for (const topic of [...kafka.topics.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      const detail = [
        topic.partitions && `partitions ${topic.partitions}`,
        topic.replicas && `replicas ${topic.replicas}`,
        topic.payloads.size && `payload ${[...topic.payloads].join(', ')}`,
        topic.groups.size && `groups ${[...topic.groups].join(', ')}`,
        topic.parent && `${topic.role} of ${topic.parent}`,
      ].filter(Boolean).join(' · ');
      this.add({ id: topicId(topic.name), kind: 'topic', name: topic.name, role: topic.role === 'dlt' ? 'dlt' : 'kafka', detail: detail || undefined });
    }
    for (const s of [...externals.systems.values()].sort((x, y) => x.id.localeCompare(y.id))) {
      this.add({ id: extId(s.id), kind: 'external', name: s.label, role: s.kind, detail: s.details.filter(Boolean).join(' · ') || undefined });
    }

    for (const e of spring.entries) this.edge({ from: entryId(e), to: methodId(e.method), kind: 'triggers', label: e.trigger });
    for (const m of this.methods.values()) {
      for (const { call, target } of a.calls.outgoing(m)) {
        if (target.kind === 'method') this.edge({ from: methodId(m), to: methodId(target.method), kind: 'calls' });
        else if (target.kind === 'external') this.edge({ from: methodId(m), to: extId(target.system.id), kind: 'uses', label: target.action });
        else if (target.kind === 'topic') this.edge({ from: methodId(m), to: topicId(target.topic), kind: 'produces', label: call.name });
        else if (target.kind === 'event') for (const l of target.listeners) this.edge({ from: methodId(m), to: entryId(l), kind: 'produces', label: `publish ${target.event}` });
      }
    }
    for (const p of kafka.producers) this.edge({ from: methodId(p.method), to: topicId(p.topic), kind: 'produces', label: p.via });
    for (const c of kafka.consumers) {
      const entry = spring.entries.find((e) => e.method === c.method);
      this.edge({ from: topicId(c.topic), to: entry ? entryId(entry) : methodId(c.method), kind: 'consumes', label: c.via });
    }
    for (const topic of kafka.topics.values()) if (topic.parent) this.edge({ from: topicId(topic.parent), to: topicId(topic.name), kind: 'produces', label: topic.role === 'dlt' ? 'dead letter' : 'retry' });
    for (const d of spring.deps) {
      if (project.types.has(d.to)) this.edge({ from: typeId(d.from), to: `type:${d.to}`, kind: 'injects', label: d.name });
    }
    for (const t of project.types.values()) {
      for (const s of t.supertypes) if (project.types.has(s)) this.edge({ from: typeId(t), to: `type:${s}`, kind: 'extends' });
    }
    for (const [sys, users] of externals.usedBy) for (const t of users) this.edge({ from: typeId(t), to: extId(sys), kind: 'uses' });
  }

  get(id: string): Fact | undefined {
    return this.facts.get(id);
  }

  outgoing(id: string, kinds?: EdgeKind[]): FactEdge[] {
    return (this.out.get(id) ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  }

  incoming(id: string, kinds?: EdgeKind[]): FactEdge[] {
    return (this.in.get(id) ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  }

  /** Ids reachable from `from` within `depth` hops, following edges forwards (and backwards when `both`). */
  reachable(from: Iterable<string>, depth: number, kinds: EdgeKind[], both = false): Set<string> {
    const seen = new Set(from);
    let frontier = [...seen];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const hops = [...this.outgoing(id, kinds).map((e) => e.to), ...(both ? this.incoming(id, kinds).map((e) => e.from) : [])];
        for (const h of hops) {
          if (seen.has(h)) continue;
          seen.add(h);
          next.push(h);
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** Ranked fuzzy search over ids, names and details. */
  search(query: string, kind?: FactKind, limit = 20): Fact[] {
    const words = query.toLowerCase().split(/[^\w./#-]+/).filter(Boolean);
    const scored: { f: Fact; s: number }[] = [];
    for (const f of this.facts.values()) {
      if (kind && f.kind !== kind) continue;
      const name = f.name.toLowerCase();
      const hay = `${f.id} ${f.name} ${f.detail ?? ''}`.toLowerCase();
      let s = 0;
      for (const w of words) {
        if (name === w) s += 10;
        else if (name.includes(w)) s += 5;
        else if (hay.includes(w)) s += 2;
        else s -= 3;
      }
      // Classes and entry points outrank their members on ties.
      if (s > 0) scored.push({ f, s: s + (f.kind === 'method' ? 0 : 1) });
    }
    return scored.sort((a, b) => b.s - a.s || a.f.id.localeCompare(b.f.id)).slice(0, limit).map((x) => x.f);
  }

  /** Source text of a type or method (or an entry's method), capped to `maxLines`. */
  source(id: string, maxLines = 120): string | undefined {
    const f = this.facts.get(id);
    if (!f) return undefined;
    if (f.kind === 'entry') return this.source(f.owner!, maxLines);
    const t = f.kind === 'type' ? this.types.get(id) : this.methods.get(id)?.owner;
    if (!t) return undefined;
    const lines = fs.readFileSync(t.absFile, 'utf8').split('\n');
    const start = (f.line ?? 1) - 1;
    const end = f.kind === 'method' ? f.endLine ?? start + 1 : Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, Math.min(end, start + maxLines));
    const more = end - start > maxLines ? `\n// … ${end - start - maxLines} more lines` : '';
    return `// ${t.file}:${start + 1}\n${slice.join('\n')}${more}`;
  }

  private add(f: Fact): void {
    if (!this.facts.has(f.id)) this.facts.set(f.id, f);
  }

  private edge(e: FactEdge): void {
    if (e.from === e.to || !this.facts.has(e.from) || !this.facts.has(e.to)) return;
    const list = this.out.get(e.from) ?? [];
    if (list.some((x) => x.to === e.to && x.kind === e.kind)) return;
    list.push(e);
    this.out.set(e.from, list);
    this.in.set(e.to, [...(this.in.get(e.to) ?? []), e]);
    this.edges.push(e);
  }
}

function outermost(t: TypeDecl): TypeDecl {
  while (t.outer) t = t.outer;
  return t;
}
