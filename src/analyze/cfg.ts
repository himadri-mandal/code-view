import type { MethodDecl, SyntaxNode } from '../model.js';

export type CfgKind = 'start' | 'end' | 'block' | 'decision' | 'loop' | 'return' | 'throw' | 'try' | 'catch' | 'finally';

export interface CfgNode {
  id: string;
  kind: CfgKind;
  lines: string[];
  line: number;
  /** Syntax nodes of the statements in this node, used to find the calls it makes. */
  stmts: SyntaxNode[];
}

export interface CfgEdge {
  from: string;
  to: string;
  label?: string;
  back?: boolean;
}

export interface Cfg {
  method: MethodDecl;
  nodes: CfgNode[];
  edges: CfgEdge[];
}

interface Exit {
  from: string;
  label?: string;
}

interface Breakable {
  label?: string;
  continueTo?: string;
  breaks: Exit[];
}

const SIMPLE = new Set(['expression_statement', 'local_variable_declaration', 'assert_statement', 'explicit_constructor_invocation', 'local_class_declaration', 'record_declaration', ';']);
const MAX_BLOCK_LINES = 8;

/** Statement-level control-flow graph; straight-line statements are merged into blocks. */
export function buildCfg(method: MethodDecl): Cfg {
  return new CfgBuilder(method).build();
}

class CfgBuilder {
  private nodes: CfgNode[] = [];
  private edges: CfgEdge[] = [];
  private stack: Breakable[] = [];
  private mergeable = new Set<string>();
  private endId = 'end';

  constructor(private readonly method: MethodDecl) {}

  build(): Cfg {
    const m = this.method;
    const start = this.node('start', [`${m.isConstructor ? m.owner.name : m.name}(${m.params.map((p) => p.name).join(', ')})`], m.line);
    this.nodes.push({ id: this.endId, kind: 'end', lines: ['end'], line: m.endLine, stmts: [] });
    const exits = m.body ? this.seq(children(m.body), [{ from: start }]) : [{ from: start }];
    this.connect(exits, this.endId);
    return { method: m, nodes: this.nodes, edges: dedupe(this.edges) };
  }

  private node(kind: CfgKind, lines: string[], line: number, stmt?: SyntaxNode): string {
    const id = `n${this.nodes.length}`;
    this.nodes.push({ id, kind, lines, line, stmts: stmt ? [stmt] : [] });
    return id;
  }

  private connect(preds: Exit[], to: string, back = false): void {
    for (const p of preds) this.edges.push({ from: p.from, to, label: p.label, back: back || undefined });
  }

  private seq(stmts: SyntaxNode[], preds: Exit[]): Exit[] {
    let cur = preds;
    for (const s of stmts) {
      if (!cur.length) break; // unreachable code after return/throw/break
      cur = this.stmt(s, cur);
    }
    return cur;
  }

  private stmt(s: SyntaxNode, preds: Exit[]): Exit[] {
    const line = s.startPosition.row + 1;
    switch (s.type) {
      case 'block':
        return this.seq(children(s), preds);
      case 'labeled_statement': {
        const body = s.namedChildren.at(-1)!;
        return this.stmt(body, preds);
      }
      case 'if_statement': {
        const dec = this.link(preds, 'decision', [`if ${flat(s.childForFieldName('condition')?.text ?? '')}`], line, s.childForFieldName('condition'));
        const thenExits = this.stmt(s.childForFieldName('consequence')!, [{ from: dec, label: 'true' }]);
        const alt = s.childForFieldName('alternative');
        const elseExits = alt ? this.stmt(alt, [{ from: dec, label: 'false' }]) : [{ from: dec, label: 'false' }];
        return [...thenExits, ...elseExits];
      }
      case 'while_statement':
      case 'for_statement':
      case 'enhanced_for_statement': {
        const body = s.childForFieldName('body')!;
        const head = flat(s.text.slice(0, body.startIndex - s.startIndex));
        const loop = this.link(preds, 'loop', [head], line, s.type === 'while_statement' ? s.childForFieldName('condition') : undefined);
        const ctx: Breakable = { continueTo: loop, breaks: [], label: labelOf(s) };
        this.stack.push(ctx);
        const bodyExits = this.stmt(body, [{ from: loop, label: s.type === 'enhanced_for_statement' ? 'next' : 'true' }]);
        this.stack.pop();
        this.connect(bodyExits, loop, true);
        return [{ from: loop, label: s.type === 'enhanced_for_statement' ? 'done' : 'false' }, ...ctx.breaks];
      }
      case 'do_statement': {
        const doNode = this.link(preds, 'loop', ['do'], line);
        const cond = this.node('decision', [`while ${flat(s.childForFieldName('condition')?.text ?? '')}`], s.endPosition.row + 1, s.childForFieldName('condition') ?? undefined);
        const ctx: Breakable = { continueTo: cond, breaks: [], label: labelOf(s) };
        this.stack.push(ctx);
        const bodyExits = this.stmt(s.childForFieldName('body')!, [{ from: doNode }]);
        this.stack.pop();
        this.connect(bodyExits, cond);
        this.edges.push({ from: cond, to: doNode, label: 'true', back: true });
        return [{ from: cond, label: 'false' }, ...ctx.breaks];
      }
      case 'switch_expression':
      case 'switch_statement':
        return this.switchStmt(s, preds, line);
      case 'expression_statement':
        if (s.namedChildren[0]?.type === 'switch_expression') return this.switchStmt(s.namedChildren[0], preds, line);
        return this.simple(s, preds, line);
      case 'try_statement':
      case 'try_with_resources_statement':
        return this.tryStmt(s, preds, line);
      case 'return_statement': {
        const r = this.link(preds, 'return', [flat(s.text.replace(/;$/, ''))], line, s);
        this.edges.push({ from: r, to: this.endId });
        return [];
      }
      case 'throw_statement': {
        const r = this.link(preds, 'throw', [flat(s.text.replace(/;$/, ''))], line, s);
        this.edges.push({ from: r, to: this.endId, label: 'throws' });
        return [];
      }
      case 'yield_statement': {
        const y = this.link(preds, 'block', [flat(s.text.replace(/;$/, ''))], line, s);
        this.target()?.breaks.push({ from: y });
        return [];
      }
      case 'break_statement': {
        const target = this.target(s.namedChildren[0]?.text);
        target?.breaks.push(...preds);
        return [];
      }
      case 'continue_statement': {
        const label = s.namedChildren[0]?.text;
        const target = [...this.stack].reverse().find((b) => b.continueTo && (!label || b.label === label));
        if (target?.continueTo) this.connect(preds, target.continueTo, true);
        return [];
      }
      case 'synchronized_statement': {
        const body = s.namedChildren.find((c) => c.type === 'block')!;
        const sync = this.link(preds, 'block', [flat(s.text.slice(0, body.startIndex - s.startIndex))], line);
        return this.stmt(body, [{ from: sync }]);
      }
      case 'line_comment':
      case 'block_comment':
        return preds;
      default:
        return this.simple(s, preds, line);
    }
  }

  private simple(s: SyntaxNode, preds: Exit[], line: number): Exit[] {
    const text = flat(s.text);
    if (preds.length === 1 && !preds[0].label && this.mergeable.has(preds[0].from)) {
      const n = this.nodes.find((x) => x.id === preds[0].from)!;
      if (n.lines.length < MAX_BLOCK_LINES) {
        n.lines.push(text);
        n.stmts.push(s);
        return preds;
      }
    }
    const id = this.link(preds, 'block', [text], line, s);
    if (SIMPLE.has(s.type) || s.type === 'expression_statement') this.mergeable.add(id);
    return [{ from: id }];
  }

  private switchStmt(s: SyntaxNode, preds: Exit[], line: number): Exit[] {
    const sw = this.link(preds, 'decision', [`switch ${flat(s.childForFieldName('condition')?.text ?? '')}`], line, s.childForFieldName('condition'));
    const ctx: Breakable = { breaks: [] };
    this.stack.push(ctx);
    const exits: Exit[] = [];
    let fallthrough: Exit[] = [];
    let hasDefault = false;
    for (const group of s.childForFieldName('body')?.namedChildren ?? []) {
      const labels = group.namedChildren.filter((c) => c.type === 'switch_label');
      const label = labels.map((l) => flat(l.text, 24)).join(' / ');
      if (labels.some((l) => l.text.startsWith('default'))) hasDefault = true;
      const body = group.namedChildren.filter((c) => c.type !== 'switch_label');
      const entry = [{ from: sw, label }, ...fallthrough];
      if (group.type === 'switch_rule') {
        exits.push(...this.seq(body, entry));
        fallthrough = [];
      } else {
        fallthrough = this.seq(body, entry);
      }
    }
    exits.push(...fallthrough);
    this.stack.pop();
    if (!hasDefault) exits.push({ from: sw, label: 'default' });
    return [...exits, ...ctx.breaks];
  }

  private tryStmt(s: SyntaxNode, preds: Exit[], line: number): Exit[] {
    const res = s.childForFieldName('resources');
    const tryId = this.link(preds, 'try', [res ? `try ${flat(res.text)}` : 'try'], line, res ?? undefined);
    let exits = this.stmt(s.childForFieldName('body')!, [{ from: tryId }]);
    for (const c of s.namedChildren.filter((x) => x.type === 'catch_clause')) {
      const param = c.namedChildren.find((x) => x.type === 'catch_formal_parameter');
      const catchId = this.node('catch', [`catch (${flat(param?.text ?? '')})`], c.startPosition.row + 1);
      this.edges.push({ from: tryId, to: catchId, label: 'throws' });
      exits = [...exits, ...this.stmt(c.childForFieldName('body')!, [{ from: catchId }])];
    }
    const fin = s.namedChildren.find((x) => x.type === 'finally_clause');
    if (fin) {
      const finId = this.link(exits, 'finally', ['finally'], fin.startPosition.row + 1);
      exits = this.stmt(fin.namedChildren.find((x) => x.type === 'block')!, [{ from: finId }]);
    }
    return exits;
  }

  private link(preds: Exit[], kind: CfgKind, lines: string[], line: number, stmt?: SyntaxNode | null): string {
    const id = this.node(kind, lines, line, stmt ?? undefined);
    this.connect(preds, id);
    return id;
  }

  private target(label?: string): Breakable | undefined {
    return [...this.stack].reverse().find((b) => !label || b.label === label);
  }
}

function children(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c) => c.type !== 'line_comment' && c.type !== 'block_comment');
}

function labelOf(s: SyntaxNode): string | undefined {
  return s.parent?.type === 'labeled_statement' ? s.parent.namedChildren[0]?.text : undefined;
}

export function flat(s: string, n = 70): string {
  const f = s.replace(/\s+/g, ' ').trim();
  return f.length > n ? `${f.slice(0, n - 1)}…` : f;
}

function dedupe(edges: CfgEdge[]): CfgEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.from}>${e.to}>${e.label ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Rough cyclomatic complexity, used to decide which methods deserve a flowchart. */
export function complexity(m: MethodDecl): number {
  if (!m.body) return 0;
  const branches = m.body.descendantsOfType([
    'if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement',
    'catch_clause', 'switch_label', 'ternary_expression',
  ]).length;
  return 1 + branches;
}
