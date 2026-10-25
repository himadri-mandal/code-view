import { hasAnno, simpleName, type CallSite, type MethodDecl, type TypeDecl } from '../model.js';
import type { SymbolTable } from './resolve.js';
import type { InfraKind, SpringModel } from './spring.js';

export interface ExternalSystem {
  id: string;
  kind: InfraKind;
  label: string;
  details: string[];
}

export interface ExternalUse {
  system: ExternalSystem;
  action: string;
}

const HTTP_TERMINALS = /^(getForObject|getForEntity|postForObject|postForEntity|patchForObject|exchange|put|delete|retrieve|exchangeToMono|exchangeToFlux)$/;
const DB_TYPES = /^(JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|EntityManager|MongoTemplate|RedisTemplate|StringRedisTemplate)$/;

/** Databases, LLMs, vector stores and HTTP services the project talks to, keyed by id. */
export class Externals {
  readonly systems = new Map<string, ExternalSystem>();
  /** Which project classes use which systems (for overview edges). */
  readonly usedBy = new Map<string, Set<TypeDecl>>();
  readonly tools: TypeDecl[] = [];
  readonly advisors = new Set<string>();

  constructor(private readonly table: SymbolTable, private readonly spring: SpringModel) {
    for (const t of table.project.types.values()) {
      if (t.methods.some((m) => hasAnno(m.annotations, 'Tool'))) this.tools.push(t);
      for (const m of t.methods) {
        for (const c of m.calls) {
          const use = this.classify(c, m);
          if (use) this.mark(use.system, t);
          if (/^(defaultAdvisors|advisors)$/.test(c.name)) {
            for (const a of c.args) this.advisors.add(a.text.match(/[A-Z]\w*Advisor/)?.[0] ?? simpleName(a.text));
          }
        }
      }
      for (const f of t.fields) this.markInfraType(f.type, t);
      for (const m of t.methods.filter((x) => hasAnno(x.annotations, 'Bean'))) this.markInfraType(m.returnType, t);
    }
  }

  private markInfraType(type: string, t: TypeDecl): void {
    const s = simpleName(type);
    if (s === 'VectorStore') this.mark(this.system('vector', 'vector', 'Vector store', [this.vectorImpl()]), t);
    else if (s === 'ChatClient' || s === 'ChatModel') this.mark(this.llm(), t);
  }

  private mark(sys: ExternalSystem, t: TypeDecl): void {
    const set = this.usedBy.get(sys.id) ?? new Set();
    set.add(t);
    this.usedBy.set(sys.id, set);
  }

  private system(id: string, kind: InfraKind, label: string, details: string[] = []): ExternalSystem {
    let s = this.systems.get(id);
    if (!s) {
      s = { id, kind, label, details: [] };
      this.systems.set(id, s);
    }
    for (const d of details) if (d && !s.details.includes(d)) s.details.push(d);
    return s;
  }

  /** What external system (if any) a call site talks to. */
  classify(call: CallSite, m: MethodDecl): ExternalUse | undefined {
    const recvDecl = this.table.type(call.receiverType);
    const root = simpleName(call.rootType ?? '');
    const recv = simpleName(call.receiverType ?? '');
    if (recvDecl && this.spring.isRepository(recvDecl) && (!call.targets.length || call.targets.every((t) => !t.body))) {
      return { system: this.database(recvDecl), action: `${recvDecl.name}.${call.name}()` };
    }
    if (recvDecl && hasAnno(recvDecl.annotations, 'FeignClient', 'HttpExchange')) {
      const a = hasAnno(recvDecl.annotations, 'FeignClient', 'HttpExchange')!;
      const target = this.table.evalStrings(a.args.url ?? a.args.name ?? a.args.value, recvDecl)[0] ?? recvDecl.name;
      return { system: this.system(`http:${target}`, 'http', `HTTP ${target}`), action: `${recvDecl.name}.${call.name}()` };
    }
    if (DB_TYPES.test(root) && call.chain.length === 1) return { system: this.database(), action: `${root}.${call.name}()` };
    if ((root === 'ChatClient' || root === 'ChatModel') && /^(call|stream)$/.test(call.name)) {
      return { system: this.llm(), action: call.chain.join('().') + '()' };
    }
    if (root === 'EmbeddingModel' && /^embed/.test(call.name)) return { system: this.llm(), action: `embed()` };
    if (recv === 'VectorStore' || root === 'VectorStore') {
      return { system: this.system('vector', 'vector', 'Vector store', [this.vectorImpl()]), action: `VectorStore.${call.name}()` };
    }
    if (/^(RestTemplate|RestClient|WebClient)$/.test(root) && HTTP_TERMINALS.test(call.name)) {
      const url = this.httpTarget(call, m.owner);
      return { system: this.system(`http:${url}`, 'http', `HTTP ${url}`), action: `${root}.${call.chain.join('().')}()` };
    }
    return undefined;
  }

  private httpTarget(call: CallSite, ctx: TypeDecl): string {
    for (let n: import('../model.js').SyntaxNode | null = call.node; n?.type === 'method_invocation'; n = n.childForFieldName('object')) {
      const name = n.childForFieldName('name')?.text ?? '';
      const arg = n.childForFieldName('arguments')?.namedChildren[0];
      if (/^(uri|getForObject|getForEntity|postForObject|postForEntity|exchange|put|delete)$/.test(name) && arg) {
        const s = this.table.evalStrings(arg, ctx)[0];
        if (s) return hostOf(s);
      }
    }
    return 'external service';
  }

  private database(repo?: TypeDecl): ExternalSystem {
    const cfg = repo ? this.table.config(repo) : this.anyConfig();
    const mongo = repo?.extends.some((e) => /Mongo/.test(e));
    if (mongo) return this.system('db:mongo', 'db', 'MongoDB', [cfg['spring.data.mongodb.database'] ?? '']);
    const url = cfg['spring.datasource.url'];
    const vendor = url?.match(/^jdbc:(\w+)/)?.[1] ?? cfg['database'] ?? 'SQL';
    return this.system('db:sql', 'db', `Database (${vendor})`, [repo ? 'Spring Data JPA' : '']);
  }

  llm(): ExternalSystem {
    const models = Object.entries(this.anyConfig())
      .filter(([k]) => /^spring\.ai\.[\w.-]+\.chat\.options\.model$/.test(k))
      .map(([k, v]) => `${k.replace(/^spring\.ai\.|\.chat\.options\.model$/g, '')}: ${v}`);
    return this.system('llm', 'llm', 'LLM', models);
  }

  private vectorImpl(): string {
    for (const t of this.table.project.types.values()) {
      for (const c of t.methods.flatMap((m) => m.calls)) {
        const r = simpleName(c.rootType ?? '');
        if (/VectorStore$/.test(r) && r !== 'VectorStore') return r;
      }
    }
    return '';
  }

  private anyConfig(): Record<string, string> {
    return Object.assign({}, ...this.table.project.config.values());
  }
}

function hostOf(url: string): string {
  const m = url.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : url.split('/').slice(0, 3).join('/') || url;
}
