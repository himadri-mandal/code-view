import { genericArgs, hasAnno, simpleName, type Annotation, type CallSite, type MethodDecl, type TypeDecl } from '../model.js';
import type { SymbolTable } from './resolve.js';

export interface TopicInfo {
  name: string;
  partitions?: string;
  replicas?: string;
  /** Parent topic for retry / dead-letter topics. */
  parent?: string;
  role: 'main' | 'retry' | 'dlt';
  payloads: Set<string>;
  groups: Set<string>;
  declaredIn?: MethodDecl;
}

export interface KafkaLink {
  topic: string;
  method: MethodDecl;
  via: string;
  call?: CallSite;
}

const PRODUCER_TYPES = /^(KafkaTemplate|KafkaOperations|ReactiveKafkaProducerTemplate|KafkaProducer|Producer)$/;
const STREAMS_TYPES = /^(StreamsBuilder|KStream|KTable|KGroupedStream)$/;

export class KafkaModel {
  readonly topics = new Map<string, TopicInfo>();
  readonly producers: KafkaLink[] = [];
  readonly consumers: KafkaLink[] = [];

  constructor(private readonly table: SymbolTable) {
    for (const t of table.project.types.values()) {
      const classListener = hasAnno(t.annotations, 'KafkaListener');
      for (const m of t.methods) {
        const listener = hasAnno(m.annotations, 'KafkaListener') ?? (hasAnno(m.annotations, 'KafkaHandler') ? classListener : undefined);
        if (listener) this.listener(m, listener, t);
        this.scanCalls(m);
        if (hasAnno(m.annotations, 'Bean')) this.functionalBinding(m);
      }
    }
  }

  get used(): boolean {
    return this.topics.size > 0;
  }

  /** Producer call → topic names, used by flow tracing for async hops. */
  topicsForCall(call: CallSite): string[] {
    return this.producers.filter((p) => p.call === call).map((p) => p.topic);
  }

  consumersOf(topic: string): KafkaLink[] {
    return this.consumers.filter((c) => c.topic === topic);
  }

  private topic(name: string, role: TopicInfo['role'] = 'main', parent?: string): TopicInfo {
    let t = this.topics.get(name);
    if (!t) {
      t = { name, role, parent, payloads: new Set(), groups: new Set() };
      this.topics.set(name, t);
    }
    return t;
  }

  private listener(m: MethodDecl, a: Annotation, t: TypeDecl): void {
    const topics = [...this.table.evalStrings(a.args.topics ?? a.args.value, t), ...this.table.evalStrings(a.args.topicPattern, t).map((p) => `pattern:${p}`)];
    const group = this.table.evalStrings(a.args.groupId ?? a.args.id, t)[0];
    const payload = payloadType(m);
    for (const name of topics) {
      const info = this.topic(name);
      if (group) info.groups.add(group);
      if (payload) info.payloads.add(payload);
      this.consumers.push({ topic: name, method: m, via: '@KafkaListener' });
    }
    const retry = hasAnno(m.annotations, 'RetryableTopic');
    if (retry) {
      const retrySuffix = this.table.evalStrings(retry.args.retryTopicSuffix, t)[0] ?? '-retry';
      const dltSuffix = this.table.evalStrings(retry.args.dltTopicSuffix, t)[0] ?? '-dlt';
      const dlt = t.methods.find((x) => hasAnno(x.annotations, 'DltHandler'));
      for (const name of topics) {
        this.topic(`${name}${retrySuffix}`, 'retry', name);
        this.consumers.push({ topic: `${name}${retrySuffix}`, method: m, via: 'retry' });
        this.topic(`${name}${dltSuffix}`, 'dlt', name);
        if (dlt) this.consumers.push({ topic: `${name}${dltSuffix}`, method: dlt, via: '@DltHandler' });
      }
    }
    const sendTo = hasAnno(m.annotations, 'SendTo');
    for (const name of sendTo ? this.table.evalStrings(sendTo.args.value, t) : []) {
      this.topic(name);
      this.producers.push({ topic: name, method: m, via: '@SendTo' });
    }
  }

  private scanCalls(m: MethodDecl): void {
    const t = m.owner;
    for (const call of m.calls) {
      const root = simpleName(call.rootType ?? '');
      const recv = simpleName(call.receiverType ?? '');
      if (PRODUCER_TYPES.test(root) && /^(send|sendDefault)$/.test(call.name) && call.chain.length === 1) {
        let names = this.table.evalStrings(call.args[0], t);
        const arg0 = call.args[0];
        if (!names.length && arg0?.type === 'object_creation_expression' && /ProducerRecord/.test(arg0.text)) {
          names = this.table.evalStrings(arg0.childForFieldName('arguments')?.namedChildren[0], t);
        }
        if (!names.length && call.name === 'sendDefault') {
          const cfg = this.table.config(t)['spring.kafka.template.default-topic'];
          if (cfg) names = [cfg];
        }
        if (!names.length) names = [`? ${call.args[0]?.text ?? 'topic'}`];
        for (const name of names) {
          this.topic(name);
          this.producers.push({ topic: name, method: m, via: `${root}.${call.name}`, call });
        }
      } else if (root === 'StreamBridge' && call.name === 'send') {
        const cfg = this.table.config(t);
        for (const binding of this.table.evalStrings(call.args[0], t)) {
          const name = cfg[`spring.cloud.stream.bindings.${binding}.destination`] ?? binding;
          this.topic(name);
          this.producers.push({ topic: name, method: m, via: 'StreamBridge.send', call });
        }
      } else if (call.isConstructor && recv === 'NewTopic') {
        const [name, partitions, replicas] = call.args;
        for (const n of this.table.evalStrings(name, t)) Object.assign(this.topic(n), { partitions: num(partitions), replicas: num(replicas), declaredIn: m });
      } else if (root === 'TopicBuilder' && call.name === 'build') {
        const parts = chainArgs(call);
        for (const n of this.table.evalStrings(parts.name?.[0], t)) {
          Object.assign(this.topic(n), { partitions: num(parts.partitions?.[0]), replicas: num(parts.replicas?.[0]), declaredIn: m });
        }
      } else if (STREAMS_TYPES.test(root) || STREAMS_TYPES.test(recv)) {
        if (call.name === 'stream' || call.name === 'table') {
          for (const n of this.table.evalStrings(call.args[0], t)) {
            this.topic(n);
            this.consumers.push({ topic: n, method: m, via: 'Kafka Streams', call });
          }
        } else if (call.name === 'to') {
          for (const n of this.table.evalStrings(call.args[0], t)) {
            this.topic(n);
            this.producers.push({ topic: n, method: m, via: 'Kafka Streams', call });
          }
        }
      }
    }
  }

  /** Spring Cloud Stream functional style: @Bean Consumer/Function/Supplier bound through config. */
  private functionalBinding(m: MethodDecl): void {
    const kind = simpleName(m.returnType);
    if (!/^(Consumer|Function|Supplier)$/.test(kind)) return;
    const cfg = this.table.config(m.owner);
    const generics = genericArgs(m.returnType).map(simpleName);
    const inDest = cfg[`spring.cloud.stream.bindings.${m.name}-in-0.destination`];
    const outDest = cfg[`spring.cloud.stream.bindings.${m.name}-out-0.destination`];
    if (inDest && kind !== 'Supplier') {
      const info = this.topic(inDest);
      if (generics[0]) info.payloads.add(generics[0]);
      const group = cfg[`spring.cloud.stream.bindings.${m.name}-in-0.group`];
      if (group) info.groups.add(group);
      this.consumers.push({ topic: inDest, method: m, via: 'Spring Cloud Stream' });
    }
    if (outDest && kind !== 'Consumer') {
      this.topic(outDest).payloads.add(generics.at(-1) ?? '');
      this.producers.push({ topic: outDest, method: m, via: 'Spring Cloud Stream' });
    }
  }
}

function num(n: import('../model.js').SyntaxNode | undefined): string | undefined {
  return n?.text.replace(/^\(\w+\)\s*/, '');
}

function payloadType(m: MethodDecl): string | undefined {
  const p = m.params.find((x) => !hasAnno(x.annotations, 'Header', 'Headers') && !/^(Acknowledgment|Consumer|MessageHeaders)$/.test(simpleName(x.type)));
  if (!p) return undefined;
  const s = simpleName(p.type);
  if (/^(ConsumerRecord|Message|List)$/.test(s)) return simpleName(genericArgs(p.type).at(-1) ?? s);
  return s;
}

/** Arguments of each step in a fluent chain, e.g. TopicBuilder.name("x").partitions(3).build(). */
function chainArgs(call: CallSite): Record<string, import('../model.js').SyntaxNode[]> {
  const out: Record<string, import('../model.js').SyntaxNode[]> = {};
  for (let n: import('../model.js').SyntaxNode | null = call.node; n?.type === 'method_invocation'; n = n.childForFieldName('object')) {
    const name = n.childForFieldName('name')?.text;
    if (name) out[name] = n.childForFieldName('arguments')?.namedChildren ?? [];
  }
  return out;
}
