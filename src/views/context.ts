import type { CallGraph, Flow } from '../analyze/callgraph.js';
import type { Externals } from '../analyze/externals.js';
import type { KafkaModel } from '../analyze/kafka.js';
import type { SymbolTable } from '../analyze/resolve.js';
import type { EntryPoint, SpringModel } from '../analyze/spring.js';
import type { MethodDecl, Project, TypeDecl } from '../model.js';

export type Editor = 'vscode' | 'cursor' | 'idea' | 'none';

export interface ViewContext {
  project: Project;
  table: SymbolTable;
  spring: SpringModel;
  kafka: KafkaModel;
  externals: Externals;
  calls: CallGraph;
  flows: Map<EntryPoint, Flow>;
  cfgMethods: Set<MethodDecl>;
  paths: Paths;
  editor: Editor;
}

/** Output file names for every canvas, unique across the run. */
export class Paths {
  readonly index = 'index.canvas';
  readonly events = 'events.canvas';
  private used = new Set<string>();
  private assigned = new Map<unknown, string>();

  component(module: string): string {
    return this.assign(`module:${module}`, `components/${safe(module)}.components.canvas`);
  }

  flow(e: EntryPoint): string {
    return this.assign(e, `flows/${safe(e.id)}.flow.canvas`);
  }

  method(m: MethodDecl): string {
    const same = m.owner.methods.filter((x) => x.name === m.name);
    const suffix = same.length > 1 ? `-${same.indexOf(m) + 1}` : '';
    return this.assign(m, `methods/${safe(`${m.owner.name}.${m.isConstructor ? 'new' : m.name}${suffix}`)}.cfg.canvas`);
  }

  private assign(key: unknown, wanted: string): string {
    const hit = this.assigned.get(key);
    if (hit) return hit;
    let p = wanted;
    for (let i = 2; this.used.has(p); i++) p = wanted.replace(/(\.\w+\.canvas)$/, `-${i}$1`);
    this.used.add(p);
    this.assigned.set(key, p);
    return p;
  }
}

export function safe(s: string): string {
  return s.replace(/[^\w.-]+/g, '_');
}

/** Obsidian wikilink; resolves both when the vault is code-view/ or the project root. */
export function link(path: string, label: string): string {
  return `[[${path}|${label.replace(/[|\]]/g, ' ')}]]`;
}

export function sourceLink(ctx: Pick<ViewContext, 'editor'>, t: TypeDecl, line: number, label?: string): string {
  const text = label ?? `${t.file.split('/').pop()}:${line}`;
  switch (ctx.editor) {
    case 'none':
      return `\`${t.file}:${line}\``;
    case 'idea':
      return `[${text}](idea://open?file=${encodeURIComponent(t.absFile)}&line=${line})`;
    default:
      return `[${text}](${ctx.editor}://file${encodeURI(t.absFile)}:${line})`;
  }
}

export function methodLabel(m: MethodDecl): string {
  return `${m.isConstructor ? `new ${m.owner.name}` : m.name}(${m.params.map((p) => p.name).join(', ')})`;
}

export function entryIcon(e: EntryPoint): string {
  return { http: '🌐', kafka: '📨', schedule: '⏰', event: '📣', 'llm-tool': '🤖', runner: '🚀', main: '🚀', 'stream-fn': '📨' }[e.kind];
}

export function entriesOf(ctx: ViewContext, m: MethodDecl): EntryPoint[] {
  return ctx.spring.entries.filter((e) => e.method === m);
}
