import type { Node as SyntaxNode } from 'web-tree-sitter';

export type { SyntaxNode };

export interface Annotation {
  name: string;
  /** Argument expression nodes keyed by element name; a single unnamed argument is stored as `value`. */
  args: Record<string, SyntaxNode>;
  text: string;
}

export interface FieldDecl {
  name: string;
  type: string;
  annotations: Annotation[];
  modifiers: string[];
  init?: SyntaxNode;
}

export interface Param {
  name: string;
  type: string;
  annotations: Annotation[];
}

export interface CallSite {
  name: string;
  /** Resolved receiver type (FQN for project types, simple/imported name for library types). */
  receiverType?: string;
  /** Type of the first receiver in a fluent chain, e.g. ChatClient for chatClient.prompt().call(). */
  rootType?: string;
  /** Method names of the whole fluent chain, innermost first. */
  chain: string[];
  args: SyntaxNode[];
  node: SyntaxNode;
  line: number;
  isConstructor?: boolean;
  /** Project methods this call may dispatch to. */
  targets: MethodDecl[];
}

export interface MethodDecl {
  id: string;
  name: string;
  owner: TypeDecl;
  params: Param[];
  returnType: string;
  annotations: Annotation[];
  modifiers: string[];
  isConstructor: boolean;
  line: number;
  endLine: number;
  body: SyntaxNode | null;
  node: SyntaxNode;
  calls: CallSite[];
}

export type TypeKind = 'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface TypeDecl {
  fqn: string;
  name: string;
  pkg: string;
  kind: TypeKind;
  module: string;
  file: string;
  absFile: string;
  line: number;
  annotations: Annotation[];
  modifiers: string[];
  extends: string[];
  implements: string[];
  /** Resolved supertypes (FQN when in project). */
  supertypes: string[];
  fields: FieldDecl[];
  methods: MethodDecl[];
  imports: string[];
  outer?: TypeDecl;
  node: SyntaxNode;
}

export interface Module {
  name: string;
  dir: string;
  sourceRoots: string[];
  resourceRoots: string[];
}

export interface Project {
  root: string;
  name: string;
  modules: Module[];
  types: Map<string, TypeDecl>;
  /** Flattened application properties per module name. */
  config: Map<string, Record<string, string>>;
}

export function hasAnno(list: Annotation[], ...names: string[]): Annotation | undefined {
  return list.find((a) => names.includes(a.name));
}

export function simpleName(type: string): string {
  const raw = type.replace(/<.*$/s, '').replace(/\[\]/g, '').trim();
  return raw.slice(raw.lastIndexOf('.') + 1);
}

export function genericArgs(type: string): string[] {
  const start = type.indexOf('<');
  if (start < 0) return [];
  const inner = type.slice(start + 1, type.lastIndexOf('>'));
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
