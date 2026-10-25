import { genericArgs, hasAnno, simpleName, type MethodDecl, type TypeDecl } from '../model.js';
import type { SymbolTable } from './resolve.js';

export type Lane = 'inbound' | 'service' | 'outbound' | 'model' | 'config' | 'other';

export const LANES: { id: Lane; title: string }[] = [
  { id: 'inbound', title: 'Inbound — REST, listeners, schedulers, LLM tools' },
  { id: 'service', title: 'Service — business logic' },
  { id: 'outbound', title: 'Outbound — repositories, producers, clients' },
  { id: 'model', title: 'Model — entities, DTOs, events' },
  { id: 'config', title: 'Config — @Configuration, properties' },
  { id: 'other', title: 'Other' },
];

const REPO_BASES = /^(Jpa|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Mongo|ReactiveCrud|ReactiveMongo|R2dbc|Elasticsearch|Neo4j|Cassandra|Redis|Couchbase|Keyvalue)?Repository$/;
const MAPPINGS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
};
/** Library types whose use makes a class an outbound adapter, with the kind of system they talk to. */
export const INFRA_TYPES: Record<string, InfraKind> = {
  KafkaTemplate: 'kafka',
  KafkaOperations: 'kafka',
  ReactiveKafkaProducerTemplate: 'kafka',
  StreamBridge: 'kafka',
  RestTemplate: 'http',
  RestClient: 'http',
  WebClient: 'http',
  JdbcTemplate: 'db',
  NamedParameterJdbcTemplate: 'db',
  JdbcClient: 'db',
  EntityManager: 'db',
  MongoTemplate: 'db',
  RedisTemplate: 'db',
  StringRedisTemplate: 'db',
  ChatClient: 'llm',
  ChatModel: 'llm',
  EmbeddingModel: 'llm',
  VectorStore: 'vector',
};

export type InfraKind = 'kafka' | 'http' | 'db' | 'llm' | 'vector';

export interface Dependency {
  from: TypeDecl;
  /** Project FQN or library simple name. */
  to: string;
  via: 'constructor' | 'field' | 'bean' | 'setter';
  name: string;
}

export type EntryKind = 'http' | 'kafka' | 'schedule' | 'event' | 'llm-tool' | 'runner' | 'main' | 'stream-fn';

export interface EntryPoint {
  id: string;
  kind: EntryKind;
  method: MethodDecl;
  /** Short trigger label, e.g. "POST /owners/new" or "@Scheduled(cron=0 0 * * * *)". */
  trigger: string;
  detail?: string;
}

export interface ClassInfo {
  type: TypeDecl;
  stereotype: string;
  lane: Lane;
  infra: Set<InfraKind>;
}

export class SpringModel {
  readonly classes = new Map<string, ClassInfo>();
  readonly deps: Dependency[] = [];
  readonly entries: EntryPoint[] = [];

  constructor(readonly table: SymbolTable) {
    for (const t of table.project.types.values()) this.classes.set(t.fqn, this.classify(t));
    for (const t of table.project.types.values()) this.collectDeps(t);
    for (const t of table.project.types.values()) this.collectEntries(t);
  }

  info(fqn: string): ClassInfo | undefined {
    return this.classes.get(fqn);
  }

  isRepository(t: TypeDecl): boolean {
    if (hasAnno(t.annotations, 'Repository')) return true;
    if (t.kind !== 'interface') return false;
    return [...t.extends.map(simpleName)].some((s) => REPO_BASES.test(s)) ||
      this.table.ancestors(t).some((a) => this.isRepository(a));
  }

  private classify(t: TypeDecl): ClassInfo {
    const a = (...n: string[]) => !!hasAnno(t.annotations, ...n);
    const methodAnno = (...n: string[]) => t.methods.some((m) => hasAnno(m.annotations, ...n));
    const infra = new Set<InfraKind>();
    for (const f of t.fields) {
      const k = INFRA_TYPES[simpleName(f.type)];
      if (k) infra.add(k);
    }
    for (const m of t.methods.filter((m) => m.isConstructor || hasAnno(m.annotations, 'Bean'))) {
      for (const p of m.params) {
        const k = INFRA_TYPES[simpleName(p.type)];
        if (k) infra.add(k);
      }
    }

    let stereotype = t.kind === 'interface' ? 'interface' : t.kind;
    let lane: Lane = 'other';
    if (a('SpringBootApplication')) [stereotype, lane] = ['@SpringBootApplication', 'config'];
    else if (a('RestController')) [stereotype, lane] = ['@RestController', 'inbound'];
    else if (a('Controller')) [stereotype, lane] = ['@Controller', 'inbound'];
    else if (a('ControllerAdvice', 'RestControllerAdvice')) [stereotype, lane] = ['@ControllerAdvice', 'inbound'];
    else if (a('FeignClient', 'HttpExchange')) [stereotype, lane] = ['@FeignClient', 'outbound'];
    else if (this.isRepository(t)) [stereotype, lane] = ['Repository', 'outbound'];
    else if (a('Configuration', 'AutoConfiguration')) [stereotype, lane] = ['@Configuration', 'config'];
    else if (a('ConfigurationProperties')) [stereotype, lane] = ['@ConfigurationProperties', 'config'];
    else if (a('Entity', 'Embeddable', 'MappedSuperclass', 'Document', 'Table')) [stereotype, lane] = [`@${t.annotations.find((x) => ['Entity', 'Embeddable', 'MappedSuperclass', 'Document', 'Table'].includes(x.name))!.name}`, 'model'];
    else if (a('Service')) [stereotype, lane] = ['@Service', 'service'];
    else if (a('Component')) [stereotype, lane] = ['@Component', 'service'];
    else if (t.kind === 'record' || t.kind === 'enum') lane = 'model';
    else if (t.kind === 'annotation') lane = 'other';

    if (methodAnno('KafkaListener', 'KafkaHandler', 'Scheduled', 'EventListener', 'TransactionalEventListener', 'Tool', 'StreamListener') || a('KafkaListener')) {
      if (lane === 'service' || lane === 'other') lane = 'inbound';
      if (methodAnno('Tool')) stereotype += ' · LLM tools';
      if (methodAnno('KafkaListener') || a('KafkaListener')) stereotype += ' · Kafka consumer';
      if (methodAnno('Scheduled')) stereotype += ' · scheduler';
    } else if (stereotype === '@Component' && infra.size) {
      // Plain components wrapping infrastructure are adapters; @Service classes stay business logic.
      lane = 'outbound';
    }
    if (lane === 'other' && t.kind === 'class' && t.fields.length && t.fields.every((f) => f.modifiers.includes('static') && f.modifiers.includes('final'))) [stereotype, lane] = ['constants', 'config'];
    if (lane === 'other' && t.kind === 'class' && /(Dto|DTO|Request|Response|Event|Message|Command|Payload)$/.test(t.name)) lane = 'model';
    if (lane === 'other' && t.kind === 'class' && t.fields.length && t.methods.every((m) => m.isConstructor || /^(get|set|is|equals|hashCode|toString)/.test(m.name))) lane = 'model';
    return { type: t, stereotype, lane, infra };
  }

  private collectDeps(t: TypeDecl): void {
    const add = (type: string, via: Dependency['via'], name: string, ctx: TypeDecl) => {
      const resolved = this.table.resolveType(type, ctx);
      const target = this.table.type(resolved) ? resolved : simpleName(type);
      if (target === t.fqn || /^(String|Integer|Long|int|long|boolean|Boolean|Resource)$/.test(target)) return;
      if (!this.table.type(target) && !INFRA_TYPES[target]) return;
      if (!this.deps.some((d) => d.from === t && d.to === target)) this.deps.push({ from: t, to: target, via, name });
    };
    const ctors = t.methods.filter((m) => m.isConstructor);
    const injected = ctors.find((c) => hasAnno(c.annotations, 'Autowired', 'Inject')) ?? (ctors.length === 1 ? ctors[0] : undefined);
    for (const p of injected?.params ?? []) add(p.type, 'constructor', p.name, t);
    const lombokCtor = hasAnno(t.annotations, 'RequiredArgsConstructor', 'AllArgsConstructor');
    for (const f of t.fields) {
      if (f.modifiers.includes('static')) continue;
      if (hasAnno(f.annotations, 'Autowired', 'Inject', 'Resource') || (lombokCtor && f.modifiers.includes('final'))) add(f.type, 'field', f.name, t);
    }
    for (const m of t.methods) {
      if (hasAnno(m.annotations, 'Bean')) for (const p of m.params) add(p.type, 'bean', p.name, t);
      else if (hasAnno(m.annotations, 'Autowired') && !m.isConstructor) for (const p of m.params) add(p.type, 'setter', p.name, t);
    }
  }

  private collectEntries(t: TypeDecl): void {
    const info = this.classes.get(t.fqn)!;
    const classPath = this.paths(hasAnno(t.annotations, 'RequestMapping')?.args, t)[0] ?? '';
    const classKafka = hasAnno(t.annotations, 'KafkaListener');
    const runner = t.supertypes.some((s) => /(^|\.)(CommandLineRunner|ApplicationRunner)$/.test(s));
    for (const m of t.methods) {
      const push = (kind: EntryKind, trigger: string, detail?: string) =>
        this.entries.push({ id: `${t.name}.${m.name}${this.overloadSuffix(m)}`, kind, method: m, trigger, detail });
      const mapping = m.annotations.find((a) => MAPPINGS[a.name]);
      if (mapping && info.lane === 'inbound') {
        let verb = MAPPINGS[mapping.name];
        if (verb === 'ANY') verb = mapping.args.method?.text.replace(/.*\./, '').replace(/[{}]/g, '') || 'ANY';
        const paths = this.paths(mapping.args, t);
        for (const p of paths.length ? paths : ['']) push('http', `${verb} ${joinPath(classPath, p)}`);
        continue;
      }
      if (hasAnno(m.annotations, 'KafkaListener') || (classKafka && hasAnno(m.annotations, 'KafkaHandler'))) push('kafka', '@KafkaListener');
      else if (hasAnno(m.annotations, 'DltHandler')) push('kafka', '@DltHandler');
      else if (hasAnno(m.annotations, 'Scheduled')) {
        const s = hasAnno(m.annotations, 'Scheduled')!;
        const args = Object.entries(s.args).map(([k, v]) => `${k}=${this.table.evalStrings(v, t)[0] ?? v.text}`).join(', ');
        push('schedule', `@Scheduled(${args})`);
      } else if (hasAnno(m.annotations, 'EventListener', 'TransactionalEventListener')) {
        push('event', `on ${simpleName(m.params[0]?.type ?? 'ApplicationEvent')}`);
      } else if (hasAnno(m.annotations, 'Tool')) {
        const d = hasAnno(m.annotations, 'Tool')!;
        push('llm-tool', `LLM tool ${m.name}`, this.table.evalStrings(d.args.description ?? d.args.value, t)[0]);
      } else if (runner && m.name === 'run') push('runner', 'on startup');
      else if (m.name === 'main' && m.modifiers.includes('static')) push('main', 'main()');
      else if (hasAnno(m.annotations, 'Bean') && /^(java\.util\.function\.)?(Consumer|Function|Supplier)</.test(m.returnType)) {
        push('stream-fn', `${simpleName(m.returnType)} binding ${m.name}`, genericArgs(m.returnType).map(simpleName).join(' → '));
      }
    }
  }

  private overloadSuffix(m: MethodDecl): string {
    const same = m.owner.methods.filter((x) => x.name === m.name);
    return same.length > 1 ? `-${same.indexOf(m) + 1}` : '';
  }

  private paths(args: Record<string, import('../model.js').SyntaxNode> | undefined, t: TypeDecl): string[] {
    if (!args) return [];
    return this.table.evalStrings(args.value ?? args.path, t);
  }
}

function joinPath(a: string, b: string): string {
  const p = `/${a}/${b}`.replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}
