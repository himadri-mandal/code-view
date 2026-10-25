import { simpleName, type CallSite, type MethodDecl, type SyntaxNode } from '../model.js';
import type { ExternalSystem, Externals } from './externals.js';
import type { KafkaModel } from './kafka.js';
import { isAccessor, type SymbolTable } from './resolve.js';
import type { EntryPoint, SpringModel } from './spring.js';

export type FlowTarget =
  | { kind: 'method'; method: MethodDecl }
  | { kind: 'external'; system: ExternalSystem; action: string }
  | { kind: 'topic'; topic: string; consumers: EntryPoint[] }
  | { kind: 'event'; event: string; listeners: EntryPoint[] };

export interface FlowStep {
  seq: number;
  from: MethodDecl;
  to: FlowTarget;
  context?: string;
  line: number;
  /** Target already expanded elsewhere in this flow (recursion / shared callee). */
  revisit?: boolean;
}

export interface Flow {
  entry: EntryPoint;
  methods: MethodDecl[];
  steps: FlowStep[];
  truncated: boolean;
}

export interface FlowOptions {
  depth: number;
  includeAccessors: boolean;
  maxSteps: number;
}

export class CallGraph {
  constructor(
    private readonly table: SymbolTable,
    private readonly spring: SpringModel,
    private readonly kafka: KafkaModel,
    private readonly externals: Externals,
    private readonly opts: FlowOptions,
  ) {}

  /** Steps leaving a single method, independent of any flow (used by method canvases). */
  outgoing(m: MethodDecl): { call: CallSite; target: FlowTarget }[] {
    const out: { call: CallSite; target: FlowTarget }[] = [];
    for (const call of m.calls) for (const target of this.targetsOf(call, m)) out.push({ call, target });
    return out;
  }

  trace(entry: EntryPoint): Flow {
    const flow: Flow = { entry, methods: [entry.method], steps: [], truncated: false };
    const visited = new Set<MethodDecl>([entry.method]);
    const walk = (m: MethodDecl, depth: number) => {
      const seen = new Set<string>();
      for (const call of m.calls) {
        for (const target of this.targetsOf(call, m)) {
          const key = targetKey(target);
          if (seen.has(key)) continue;
          seen.add(key);
          if (flow.steps.length >= this.opts.maxSteps) {
            flow.truncated = true;
            return;
          }
          const revisit = target.kind === 'method' && visited.has(target.method);
          flow.steps.push({ seq: flow.steps.length + 1, from: m, to: target, context: callContext(call.node, m), line: call.line, revisit });
          if (target.kind !== 'method' || revisit) continue;
          visited.add(target.method);
          flow.methods.push(target.method);
          if (depth + 1 < this.opts.depth) walk(target.method, depth + 1);
          else if (target.method.calls.some((c) => this.targetsOf(c, target.method).length)) flow.truncated = true;
        }
      }
    };
    walk(entry.method, 0);
    return flow;
  }

  private targetsOf(call: CallSite, m: MethodDecl): FlowTarget[] {
    const topics = this.kafka.topicsForCall(call);
    if (topics.length) {
      return topics.map((topic) => ({
        kind: 'topic',
        topic,
        consumers: this.kafka.consumersOf(topic).flatMap((c) => this.spring.entries.filter((e) => e.method === c.method)),
      }));
    }
    const ext = this.externals.classify(call, m);
    if (ext) return [{ kind: 'external', ...ext }];
    if (call.name === 'publishEvent' && /ApplicationEventPublisher|ApplicationContext/.test(call.rootType ?? '')) {
      const event = this.argType(call.args[0], m);
      const listeners = this.spring.entries.filter((e) => e.kind === 'event' && simpleName(e.method.params[0]?.type ?? '') === event);
      return [{ kind: 'event', event, listeners }];
    }
    return call.targets
      .filter((t) => !t.isConstructor || (t.body?.namedChildren.length ?? 0) > 2)
      .filter((t) => this.opts.includeAccessors || !isAccessor(t))
      .map((method) => ({ kind: 'method', method }));
  }

  private argType(arg: SyntaxNode | undefined, m: MethodDecl): string {
    if (!arg) return 'event';
    if (arg.type === 'object_creation_expression') return simpleName(arg.childForFieldName('type')?.text ?? 'event');
    const p = m.params.find((x) => x.name === arg.text);
    return simpleName(p?.type ?? arg.text);
  }
}

export function targetKey(t: FlowTarget): string {
  switch (t.kind) {
    case 'method':
      return `m:${t.method.id}`;
    case 'external':
      return `x:${t.system.id}:${t.action}`;
    case 'topic':
      return `t:${t.topic}`;
    case 'event':
      return `e:${t.event}`;
  }
}

/** Short description of the branch/loop a call sits in, e.g. "if result.hasErrors()" or "loop". */
export function callContext(node: SyntaxNode, m: MethodDecl): string | undefined {
  const parts: string[] = [];
  let child = node;
  for (let n = node.parent; n && n.id !== m.body?.id && parts.length < 2; child = n, n = n.parent) {
    switch (n.type) {
      case 'if_statement': {
        const cond = short(n.childForFieldName('condition')?.text.replace(/^\(|\)$/g, '') ?? '');
        if (n.childForFieldName('condition')?.id === child.id) parts.push(`in if (${cond})`);
        else if (n.childForFieldName('alternative')?.id === child.id) parts.push(`else of (${cond})`);
        else parts.push(`if ${cond}`);
        break;
      }
      case 'ternary_expression':
        parts.push(`? ${short(n.childForFieldName('condition')?.text ?? '')}`);
        break;
      case 'for_statement':
      case 'enhanced_for_statement':
      case 'while_statement':
      case 'do_statement':
        parts.push('loop');
        break;
      case 'catch_clause':
        parts.push(`catch ${n.namedChildren.find((c) => c.type === 'catch_formal_parameter')?.namedChildren[0]?.text ?? ''}`.trim());
        break;
      case 'finally_clause':
        parts.push('finally');
        break;
      case 'switch_block_statement_group':
      case 'switch_rule':
        parts.push(short(n.namedChildren[0]?.text ?? 'case'));
        break;
      case 'lambda_expression':
        parts.push('λ');
        break;
    }
  }
  return parts.length ? parts.reverse().join(' › ') : undefined;
}

function short(s: string, n = 32): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
