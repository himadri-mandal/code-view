import { resolvePlaceholders } from '../config.js';
import { hasAnno, simpleName, type CallSite, type FieldDecl, type MethodDecl, type Project, type SyntaxNode, type TypeDecl } from '../model.js';

const MAX_IMPLS = 4;

/**
 * Heuristic symbol resolution over the parsed project: no classpath, so library types stay as
 * their imported (or simple) names while project types resolve to FQNs.
 */
export class SymbolTable {
  readonly implementors = new Map<string, TypeDecl[]>();

  constructor(readonly project: Project) {
    for (const t of project.types.values()) {
      t.supertypes = [...t.extends, ...t.implements].map((s) => this.resolveType(s, t));
    }
    for (const t of project.types.values()) {
      for (const s of t.supertypes) {
        if (!project.types.has(s)) continue;
        const list = this.implementors.get(s) ?? [];
        list.push(t);
        this.implementors.set(s, list);
      }
    }
  }

  type(fqn: string | undefined): TypeDecl | undefined {
    return fqn ? this.project.types.get(fqn) : undefined;
  }

  /** Resolves a type reference written inside `ctx`; returns a project FQN when possible. */
  resolveType(written: string, ctx: TypeDecl): string {
    const name = written.replace(/<.*$/s, '').replace(/\[\]/g, '').replace(/^@/, '').trim();
    const types = this.project.types;
    if (types.has(name)) return name;
    if (name.includes('.')) {
      const [first, ...rest] = name.split('.');
      const head = this.resolveType(first, ctx);
      const joined = `${head}.${rest.join('.')}`;
      return types.has(joined) ? joined : name;
    }
    for (let t: TypeDecl | undefined = ctx; t; t = t.outer) {
      if (types.has(`${t.fqn}.${name}`)) return `${t.fqn}.${name}`;
      if (t.name === name) return t.fqn;
    }
    const imported = ctx.imports.find((i) => !i.startsWith('static ') && i.endsWith(`.${name}`));
    if (imported) return imported;
    const samePkg = ctx.pkg ? `${ctx.pkg}.${name}` : name;
    if (types.has(samePkg)) return samePkg;
    for (const i of ctx.imports) {
      if (i.endsWith('.*') && !i.startsWith('static ')) {
        const cand = `${i.slice(0, -2)}.${name}`;
        if (types.has(cand)) return cand;
      }
    }
    return name;
  }

  /** Project supertypes, nearest first. */
  ancestors(t: TypeDecl): TypeDecl[] {
    const out: TypeDecl[] = [];
    const queue = [...t.supertypes];
    while (queue.length) {
      const s = this.type(queue.shift());
      if (!s || out.includes(s)) continue;
      out.push(s);
      queue.push(...s.supertypes);
    }
    return out;
  }

  findField(t: TypeDecl, name: string): { field: FieldDecl; owner: TypeDecl } | undefined {
    for (let o: TypeDecl | undefined = t; o; o = o.outer) {
      for (const c of [o, ...this.ancestors(o)]) {
        const field = c.fields.find((f) => f.name === name);
        if (field) return { field, owner: c };
      }
    }
    return undefined;
  }

  /** Methods named `name` reachable from type `t`, with abstract methods replaced by their implementations. */
  findMethods(t: TypeDecl, name: string, argc: number): MethodDecl[] {
    const matches = (m: MethodDecl) =>
      m.name === name && (m.params.length === argc || m.params.at(-1)?.type.endsWith('[]') || m.params.at(-1)?.type.includes('...'));
    let found: MethodDecl[] = [];
    for (const c of [t, ...this.ancestors(t)]) {
      found = c.methods.filter(matches);
      if (found.length) break;
    }
    const out: MethodDecl[] = [];
    for (const m of found) {
      if (m.body) {
        out.push(m);
        continue;
      }
      const impls = this.allImplementors(m.owner.fqn)
        .map((i) => i.methods.find((x) => x.body && matches(x)))
        .filter((x): x is MethodDecl => !!x);
      if (impls.length && impls.length <= MAX_IMPLS) out.push(...impls);
      else out.push(m);
    }
    return out;
  }

  allImplementors(fqn: string): TypeDecl[] {
    const out: TypeDecl[] = [];
    const queue = [...(this.implementors.get(fqn) ?? [])];
    while (queue.length) {
      const t = queue.shift()!;
      if (out.includes(t)) continue;
      out.push(t);
      queue.push(...(this.implementors.get(t.fqn) ?? []));
    }
    return out;
  }

  config(t: TypeDecl): Record<string, string> {
    return this.project.config.get(t.module) ?? {};
  }

  /** Statically evaluates a String-valued expression (literals, constants, concatenation, @Value fields). */
  evalStrings(node: SyntaxNode | undefined | null, ctx: TypeDecl, depth = 0): string[] {
    if (!node || depth > 8) return [];
    const cfg = this.config(ctx);
    switch (node.type) {
      case 'string_literal':
        return [resolvePlaceholders(stringContent(node.text), cfg)];
      case 'text_block':
        return [stringContent(node.text)];
      case 'element_value_array_initializer':
      case 'array_initializer':
        return node.namedChildren.flatMap((c) => this.evalStrings(c, ctx, depth + 1));
      case 'parenthesized_expression':
        return this.evalStrings(node.namedChildren[0], ctx, depth + 1);
      case 'binary_expression': {
        const l = this.evalStrings(node.childForFieldName('left'), ctx, depth + 1);
        const r = this.evalStrings(node.childForFieldName('right'), ctx, depth + 1);
        return l.length && r.length ? [l[0] + r[0]] : [];
      }
      case 'identifier': {
        const hit = this.findField(ctx, node.text);
        if (hit) return this.fieldValue(hit.field, hit.owner, depth);
        const stat = ctx.imports.find((i) => i.startsWith('static ') && i.endsWith(`.${node.text}`));
        if (stat) {
          const owner = this.type(stat.slice(7, -(node.text.length + 1)));
          const f = owner?.fields.find((x) => x.name === node.text);
          if (owner && f) return this.fieldValue(f, owner, depth);
        }
        return [];
      }
      case 'field_access': {
        const obj = node.childForFieldName('object');
        const field = node.childForFieldName('field')?.text;
        if (!obj || !field) return [];
        const owner = obj.type === 'this' ? ctx : this.type(this.resolveType(obj.text, ctx));
        const hit = owner && this.findField(owner, field);
        return hit ? this.fieldValue(hit.field, hit.owner, depth) : [];
      }
      default:
        return [];
    }
  }

  private fieldValue(field: FieldDecl, owner: TypeDecl, depth: number): string[] {
    if (field.init) return this.evalStrings(field.init, owner, depth + 1);
    const value = hasAnno(field.annotations, 'Value');
    if (value) return this.evalStrings(value.args.value, owner, depth + 1);
    return [];
  }
}

export function stringContent(text: string): string {
  if (text.startsWith('"""')) return text.slice(3, -3).replace(/\\\n/g, '').replace(/^\s*\n/, '').replace(/\s+/g, ' ').trim();
  return text.replace(/^"|"$/g, '');
}

type Scope = Map<string, string>;

/** Fills `calls` on every method in the project. */
export function linkCalls(table: SymbolTable): void {
  for (const t of table.project.types.values()) {
    for (const m of t.methods) {
      if (!m.body) continue;
      const scope: Scope = new Map(m.params.map((p) => [p.name, table.resolveType(p.type, t)]));
      collectLocals(m.body, t, table, scope);
      m.calls = m.body
        .descendantsOfType(['method_invocation', 'object_creation_expression'])
        .filter((n): n is SyntaxNode => !!n)
        .map((n) => toCallSite(n, t, table, scope))
        .sort((a, b) => a.node.startIndex - b.node.startIndex);
    }
  }
}

function collectLocals(body: SyntaxNode, t: TypeDecl, table: SymbolTable, scope: Scope): void {
  const decls = body.descendantsOfType([
    'local_variable_declaration',
    'enhanced_for_statement',
    'catch_formal_parameter',
    'resource',
    'formal_parameter',
    'type_pattern',
    'record_pattern_component',
  ]);
  for (const d of decls) {
    if (!d) continue;
    const typeNode = d.childForFieldName('type') ?? d.namedChildren.find((c) => c.type.endsWith('_type') || c.type === 'type_identifier' || c.type === 'catch_type');
    const type = typeNode?.text ?? '';
    const names = d.type === 'local_variable_declaration'
      ? d.childrenForFieldName('declarator').map((v) => ({ name: v.childForFieldName('name')?.text, init: v.childForFieldName('value') }))
      : [{ name: (d.childForFieldName('name') ?? d.namedChildren.find((c) => c.type === 'identifier'))?.text, init: d.childForFieldName('value') }];
    for (const { name, init } of names) {
      if (!name) continue;
      let resolved = type;
      if (type === 'var' && init) resolved = exprType(init, t, table, scope) ?? 'var';
      else if (type.includes('|')) resolved = type.split('|')[0].trim();
      scope.set(name, resolved === 'var' ? 'var' : table.resolveType(resolved, t));
    }
  }
}

function exprType(expr: SyntaxNode, t: TypeDecl, table: SymbolTable, scope: Scope): string | undefined {
  switch (expr.type) {
    case 'this':
      return t.fqn;
    case 'identifier': {
      const local = scope.get(expr.text);
      if (local) return local;
      const hit = table.findField(t, expr.text);
      if (hit) return table.resolveType(hit.field.type, hit.owner);
      return /^[A-Z]/.test(expr.text) ? table.resolveType(expr.text, t) : undefined;
    }
    case 'field_access': {
      const obj = expr.childForFieldName('object');
      const field = expr.childForFieldName('field')?.text ?? '';
      if (!obj) return undefined;
      const objType = exprType(obj, t, table, scope);
      const owner = table.type(objType);
      const hit = owner && table.findField(owner, field);
      if (hit) return table.resolveType(hit.field.type, hit.owner);
      const asType = table.resolveType(expr.text, t);
      return table.type(asType) ? asType : undefined;
    }
    case 'method_invocation': {
      const call = toCallSite(expr, t, table, scope);
      const target = call.targets[0];
      return target ? table.resolveType(target.returnType, target.owner) : undefined;
    }
    case 'object_creation_expression':
    case 'cast_expression':
      return table.resolveType(expr.childForFieldName('type')?.text ?? '', t);
    case 'parenthesized_expression':
      return expr.namedChildren[0] ? exprType(expr.namedChildren[0], t, table, scope) : undefined;
    case 'string_literal':
      return 'String';
    default:
      return undefined;
  }
}

function toCallSite(node: SyntaxNode, t: TypeDecl, table: SymbolTable, scope: Scope): CallSite {
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  const line = node.startPosition.row + 1;
  if (node.type === 'object_creation_expression') {
    const type = table.resolveType(node.childForFieldName('type')?.text ?? '', t);
    const decl = table.type(type);
    const targets = decl ? decl.methods.filter((m) => m.isConstructor && m.params.length === args.length) : [];
    return { name: '<init>', receiverType: type, rootType: type, chain: ['<init>'], args, node, line, isConstructor: true, targets };
  }

  const name = node.childForFieldName('name')?.text ?? '?';
  const object = node.childForFieldName('object');
  const chain: string[] = [name];
  let root: SyntaxNode | null = object;
  while (root?.type === 'method_invocation') {
    chain.unshift(root.childForFieldName('name')?.text ?? '?');
    root = root.childForFieldName('object');
  }

  let receiverType: string | undefined;
  let targets: MethodDecl[] = [];
  if (!object) {
    for (let o: TypeDecl | undefined = t; o && !targets.length; o = o.outer) {
      targets = table.findMethods(o, name, args.length);
      receiverType = o.fqn;
    }
    if (!targets.length) {
      const stat = t.imports.find((i) => i.startsWith('static ') && (i.endsWith(`.${name}`) || i.endsWith('.*')));
      if (stat) {
        receiverType = stat.slice(7).replace(/\.(\*|[^.]+)$/, '');
        const owner = table.type(receiverType);
        if (owner) targets = table.findMethods(owner, name, args.length);
      }
    }
  } else if (object.type === 'super') {
    const sup = table.type(t.supertypes[0]);
    receiverType = sup?.fqn ?? t.supertypes[0];
    if (sup) targets = table.findMethods(sup, name, args.length);
  } else {
    receiverType = exprType(object, t, table, scope);
    const owner = table.type(receiverType);
    if (owner) targets = table.findMethods(owner, name, args.length);
  }
  const rootType = root ? exprType(root, t, table, scope) : receiverType;
  return { name, receiverType, rootType, chain, args, node, line, targets };
}

export function isAccessor(m: MethodDecl): boolean {
  if (!/^(get|set|is|has)[A-Z]/.test(m.name) && !(m.owner.kind === 'record' && m.params.length === 0)) return false;
  const stmts = m.body?.namedChildren.filter((n) => n.type !== 'comment') ?? [];
  return stmts.length <= 1 && !m.body?.descendantsOfType(['method_invocation']).some((c) => c && !/^(get|set|is)[A-Z]/.test(c.childForFieldName('name')?.text ?? ''));
}

export function typeLabel(type: string | undefined): string {
  return type ? simpleName(type) : '?';
}
