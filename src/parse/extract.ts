import type { Annotation, FieldDecl, MethodDecl, Param, SyntaxNode, TypeDecl, TypeKind } from '../model.js';

const TYPE_NODES: Record<string, TypeKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

export interface FileInfo {
  module: string;
  file: string;
  absFile: string;
}

/** Turns one parsed compilation unit into type declarations (nested types included). */
export function extractTypes(root: SyntaxNode, info: FileInfo): TypeDecl[] {
  let pkg = '';
  const imports: string[] = [];
  const out: TypeDecl[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration') {
      pkg = child.namedChildren.find((n) => n.type !== 'annotation' && n.type !== 'marker_annotation')?.text ?? '';
    } else if (child.type === 'import_declaration') {
      imports.push(child.text.replace(/^import\s+/, '').replace(/;$/, '').replace(/\s+/g, ' ').trim());
    } else if (TYPE_NODES[child.type]) {
      visitType(child, pkg, imports, info, undefined, out);
    }
  }
  return out;
}

function visitType(
  node: SyntaxNode,
  pkg: string,
  imports: string[],
  info: FileInfo,
  outer: TypeDecl | undefined,
  out: TypeDecl[],
): void {
  const name = node.childForFieldName('name')?.text ?? '?';
  const { annotations, modifiers } = readModifiers(node);
  const fqn = outer ? `${outer.fqn}.${name}` : pkg ? `${pkg}.${name}` : name;
  const type: TypeDecl = {
    fqn,
    name,
    pkg,
    kind: TYPE_NODES[node.type],
    module: info.module,
    file: info.file,
    absFile: info.absFile,
    line: node.startPosition.row + 1,
    annotations,
    modifiers,
    extends: [],
    implements: [],
    supertypes: [],
    fields: [],
    methods: [],
    imports,
    outer,
    node,
  };

  const superclass = node.childForFieldName('superclass');
  if (superclass) type.extends.push(...typeList(superclass));
  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) type.implements.push(...typeList(interfaces));
  const extIfaces = node.namedChildren.find((n) => n.type === 'extends_interfaces');
  if (extIfaces) type.extends.push(...typeList(extIfaces));

  if (type.kind === 'record') {
    for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
      const param = readParam(p);
      if (param) type.fields.push({ name: param.name, type: param.type, annotations: param.annotations, modifiers: ['private', 'final'] });
    }
  }

  out.push(type);
  const body = node.childForFieldName('body');
  if (!body) return;
  const members = body.type === 'enum_body'
    ? body.namedChildren.flatMap((n) => (n.type === 'enum_body_declarations' ? n.namedChildren : []))
    : body.namedChildren;

  for (const m of members) {
    if (TYPE_NODES[m.type]) visitType(m, pkg, imports, info, type, out);
    else if (m.type === 'field_declaration' || m.type === 'constant_declaration') type.fields.push(...readFields(m));
    else if (m.type === 'method_declaration' || m.type === 'constructor_declaration' || m.type === 'compact_constructor_declaration' || m.type === 'annotation_type_element_declaration') {
      type.methods.push(readMethod(m, type));
    }
  }
}

function typeList(node: SyntaxNode): string[] {
  const list = node.namedChildren.find((n) => n.type === 'type_list');
  return (list ? list.namedChildren : node.namedChildren).map((n) => n.text);
}

export function readModifiers(node: SyntaxNode): { annotations: Annotation[]; modifiers: string[] } {
  const mods = node.namedChildren.find((n) => n.type === 'modifiers');
  const annotations: Annotation[] = [];
  const modifiers: string[] = [];
  if (!mods) return { annotations, modifiers };
  for (const c of mods.children) {
    if (c.type === 'annotation' || c.type === 'marker_annotation') annotations.push(readAnnotation(c));
    else modifiers.push(c.text);
  }
  return { annotations, modifiers };
}

function readAnnotation(node: SyntaxNode): Annotation {
  const fullName = node.childForFieldName('name')?.text ?? '';
  const args: Record<string, SyntaxNode> = {};
  const list = node.childForFieldName('arguments');
  for (const arg of list?.namedChildren ?? []) {
    if (arg.type === 'element_value_pair') {
      const key = arg.childForFieldName('key')?.text;
      const value = arg.childForFieldName('value');
      if (key && value) args[key] = value;
    } else if (arg.type !== 'comment') {
      args.value = arg;
    }
  }
  return { name: fullName.slice(fullName.lastIndexOf('.') + 1), args, text: node.text };
}

function readFields(node: SyntaxNode): FieldDecl[] {
  const { annotations, modifiers } = readModifiers(node);
  const type = node.childForFieldName('type')?.text ?? '?';
  return node.childrenForFieldName('declarator').map((d) => ({
    name: d.childForFieldName('name')?.text ?? '?',
    type: type + (d.childForFieldName('dimensions')?.text ?? ''),
    annotations,
    modifiers,
    init: d.childForFieldName('value') ?? undefined,
  }));
}

function readParam(node: SyntaxNode): Param | undefined {
  if (node.type !== 'formal_parameter' && node.type !== 'spread_parameter') return undefined;
  const { annotations } = readModifiers(node);
  const typeNode = node.namedChildren.find((n) => n.type !== 'modifiers' && n.type !== 'variable_declarator' && n.type !== 'identifier');
  const nameNode = node.childForFieldName('name') ?? node.namedChildren.find((n) => n.type === 'variable_declarator')?.childForFieldName('name');
  const type = (node.childForFieldName('type') ?? typeNode)?.text ?? '?';
  return { name: nameNode?.text ?? '?', type: node.type === 'spread_parameter' ? `${type}[]` : type, annotations };
}

function readMethod(node: SyntaxNode, owner: TypeDecl): MethodDecl {
  const { annotations, modifiers } = readModifiers(node);
  const isConstructor = node.type !== 'method_declaration' && node.type !== 'annotation_type_element_declaration';
  const name = isConstructor ? '<init>' : (node.childForFieldName('name')?.text ?? '?');
  const params = isConstructor && node.type === 'compact_constructor_declaration'
    ? owner.fields.map((f) => ({ name: f.name, type: f.type, annotations: [] }))
    : (node.childForFieldName('parameters')?.namedChildren ?? []).map(readParam).filter((p): p is Param => !!p);
  const sig = params.map((p) => p.type.replace(/<.*>/s, '')).join(',');
  return {
    id: `${owner.fqn}#${name}(${sig})`,
    name,
    owner,
    params,
    returnType: isConstructor ? owner.name : (node.childForFieldName('type')?.text ?? 'void'),
    annotations,
    modifiers,
    isConstructor,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    body: node.childForFieldName('body'),
    node,
    calls: [],
  };
}
