import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { targetKey } from '../analyze/callgraph.js';
import { EDGE_KINDS, entryId, extId, methodId, topicId, type Fact, type FactsIndex } from '../facts/index.js';
import { ProjectSession } from '../facts/session.js';
import { generate, type GenerateOptions } from '../generate.js';
import { mergePatch, ViewStore, type RenderResult } from '../spec/registry.js';
import { parseSpec } from '../spec/schema.js';
import { compileSpec } from '../spec/compile.js';
import type { Editor } from '../views/context.js';
import { DESIGN_GUIDE, SPEC_REFERENCE } from './guide.js';

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string, extra: Record<string, unknown> = {}) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }] });

const brief = (f: Fact) => ({ id: f.id, kind: f.kind, name: f.name, role: f.role, ...(f.detail ? { detail: f.detail } : {}) });

export function createServer(root: string, opts: GenerateOptions = {}): McpServer {
  const session = new ProjectSession(root, opts);
  const store = new ViewStore(session.outDir);
  const editor: Editor = opts.editor ?? 'vscode';
  const server = new McpServer({ name: 'java-canvas', version: '0.1.0' });

  server.registerTool('project_summary', {
    description: 'Overview of the Java project: modules, counts, entry points, Kafka topics, external systems and saved views. Call this first.',
  }, async () => {
    const f = await session.facts();
    const all = [...f.facts.values()];
    const count = (k: string) => all.filter((x) => x.kind === k).length;
    return ok({
      project: f.a.project.name,
      outDir: session.outDir,
      modules: f.a.project.modules.map((m) => m.name),
      counts: { types: count('type'), methods: count('method'), entries: count('entry'), topics: count('topic'), externals: count('external'), edges: f.edges.length },
      entries: all.filter((x) => x.kind === 'entry').map(brief),
      topics: all.filter((x) => x.kind === 'topic').map(brief),
      externals: all.filter((x) => x.kind === 'external').map(brief),
      views: store.list(),
    });
  });

  server.registerTool('search', {
    description: 'Fuzzy search facts (types, methods, entry points, topics, external systems) by name. Returns ids to use in view selectors.',
    inputSchema: { query: z.string(), kind: z.enum(['type', 'method', 'entry', 'topic', 'external']).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ query, kind, limit }) => ok((await session.facts()).search(query, kind, limit ?? 20).map(brief)));

  server.registerTool('get', {
    description: 'One fact with its incoming and outgoing edges.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const f = await session.facts();
    const fact = f.get(id);
    if (!fact) return fail(`unknown id ${id}`, { suggestions: f.search(id.replace(/^\w+:/, ''), undefined, 5).map((x) => x.id) });
    const members = fact.kind === 'type' ? [...f.facts.values()].filter((m) => m.owner === id).map(brief) : undefined;
    return ok({ ...fact, members, outgoing: f.outgoing(id).slice(0, 60), incoming: f.incoming(id).slice(0, 60) });
  });

  server.registerTool('neighbors', {
    description: 'Facts within `depth` hops of an id, following the given edge kinds (forwards, or both directions).',
    inputSchema: { id: z.string(), via: z.array(z.enum(EDGE_KINDS)).optional(), depth: z.number().int().min(1).max(8).optional(), both: z.boolean().optional() },
  }, async ({ id, via, depth, both }) => {
    const f = await session.facts();
    if (!f.get(id)) return fail(`unknown id ${id}`);
    const ids = f.reachable([id], depth ?? 2, via ?? [...EDGE_KINDS], both);
    return ok([...ids].sort().slice(0, 200).map((x) => brief(f.get(x)!)));
  });

  server.registerTool('trace', {
    description: 'Ordered call flow from an entry point (as drawn in the generated flow canvas): numbered steps with branch context.',
    inputSchema: { entry: z.string().describe('entry id, e.g. entry:OrderController.create') },
  }, async ({ entry }) => {
    const f = await session.facts();
    const e = f.entries.get(entry);
    if (!e) return fail(`unknown entry ${entry}`, { entries: [...f.entries.keys()] });
    const flow = f.a.calls.trace(e);
    const to = (t: (typeof flow.steps)[number]['to']) =>
      t.kind === 'method' ? methodId(t.method) : t.kind === 'external' ? extId(t.system.id) : t.kind === 'topic' ? topicId(t.topic) : t.listeners.map(entryId).join(', ') || targetKey(t);
    return ok({
      entry,
      truncated: flow.truncated,
      steps: flow.steps.map((s) => ({ seq: s.seq, from: methodId(s.from), to: to(s.to), ...(s.context ? { context: s.context } : {}), ...(s.to.kind === 'external' ? { action: s.to.action } : {}) })),
    });
  });

  server.registerTool('source', {
    description: 'Source code of a type, method or entry point, to understand what it does before labelling or annotating it.',
    inputSchema: { id: z.string(), maxLines: z.number().int().min(5).max(400).optional() },
  }, async ({ id, maxLines }) => {
    const src = (await session.facts()).source(id, maxLines);
    return src ? { content: [{ type: 'text' as const, text: src }] } : fail(`no source for ${id}`);
  });

  server.registerTool('list_views', { description: 'Saved views (specs) with their questions and canvas paths.' }, async () => ok(store.list()));

  server.registerTool('find_view', {
    description: 'Saved views that already answer a question, best match first. Always call before create_view: if one fits, update it instead of creating a new one so the canvas stays stable.',
    inputSchema: { question: z.string() },
  }, async ({ question }) => ok(store.find(question)));

  server.registerTool('get_view', {
    description: 'The full spec of a saved view.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const { spec, errors } = store.read(name);
    return spec ? ok(spec) : fail(errors.join('; '));
  });

  server.registerTool('spec_reference', { description: 'Reference for the view spec format and selectors.' }, async () => ({ content: [{ type: 'text' as const, text: SPEC_REFERENCE }] }));

  const finish = async (res: RenderResult) => {
    if (res.errors.length) return fail('view not rendered', { errors: res.errors, warnings: res.warnings });
    const canvas = store.previous(res.canvas!)!;
    const headlines = canvas.nodes.map((n) => (n.type === 'group' ? `[${n.label}]` : n.type === 'text' ? n.text.split('\n')[0] : n.type));
    return ok({ ...res, path: path.join(session.outDir, res.canvas!), shown: headlines.slice(0, 80) });
  };

  server.registerTool('create_view', {
    description: `Save a new view spec and render it to <outDir>/views/<name>.canvas. Rejected if any id is unknown, a selector matches nothing, or the view is too big. Use dry_run to preview. ${SPEC_REFERENCE}`,
    inputSchema: { spec: z.record(z.string(), z.unknown()), dry_run: z.boolean().optional(), overwrite: z.boolean().optional() },
  }, async ({ spec: raw, dry_run, overwrite }) => {
    const { spec, errors } = parseSpec(raw);
    if (!spec) return fail('invalid spec', { errors });
    if (!overwrite && store.raw(spec.name) !== undefined) return fail(`view ${spec.name} exists; use update_view to change it (keeps the layout stable) or pass overwrite`);
    const facts = await session.facts();
    if (dry_run) return preview(facts, spec);
    const res = await store.render(spec, facts, { editor, strict: true });
    if (!res.errors.length) store.write(spec);
    return finish(res);
  });

  server.registerTool('update_view', {
    description: 'Change a saved view with a JSON merge patch (objects merge, null deletes a key, arrays are replaced whole). Existing nodes keep their positions; the result lists added, removed and changed nodes.',
    inputSchema: { name: z.string(), patch: z.record(z.string(), z.unknown()), dry_run: z.boolean().optional() },
  }, async ({ name, patch, dry_run }) => {
    const raw = store.raw(name);
    if (raw === undefined) return fail(`no view named ${name}`, { views: store.list().map((v) => v.name) });
    if ('name' in patch && patch.name !== name) return fail('renaming a view is not supported; create a new one');
    const { spec, errors } = parseSpec(mergePatch(raw, patch));
    if (!spec) return fail('invalid spec after patch', { errors });
    const facts = await session.facts();
    if (dry_run) return preview(facts, spec);
    const res = await store.render(spec, facts, { editor, strict: true });
    if (!res.errors.length) store.write(spec);
    return finish(res);
  });

  server.registerTool('render', {
    description: 'Re-render saved views from the current code without changing their specs (all views when name is omitted). Reports what changed since the last render.',
    inputSchema: { name: z.string().optional(), relayout: z.boolean().optional().describe('discard previous positions') },
  }, async ({ name, relayout }) => {
    const facts = await session.facts();
    const names = name ? [name] : store.list().map((v) => v.name);
    const out: RenderResult[] = [];
    for (const n of names) {
      const { spec, errors } = store.read(n);
      out.push(spec ? await store.render(spec, facts, { editor, relayout }) : { name: n, nodes: 0, errors, warnings: [] });
    }
    return ok(out);
  });

  server.registerTool('generate_all', {
    description: 'Regenerate the built-in canvases (index, events, components, flows, method flowcharts) plus all saved views.',
  }, async () => {
    const res = await generate(session.root, { ...opts, out: session.outDir });
    return ok({ outDir: res.outDir, files: res.files.length, stats: res.stats, views: res.views });
  });

  server.registerPrompt('design-canvas', {
    description: 'Design (or update) a canvas that answers a question about the codebase.',
    argsSchema: { question: z.string() },
  }, ({ question }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `${DESIGN_GUIDE}\n\nQuestion: ${question}` } }],
  }));

  return server;
}

function preview(facts: FactsIndex, spec: Parameters<typeof compileSpec>[0]) {
  const res = compileSpec(spec, facts, { strict: true });
  return ok({
    dry_run: true,
    nodes: res.nodes,
    errors: res.errors,
    warnings: res.warnings,
    groups: res.graph.groups.map((g) => g.label),
    shown: res.graph.nodes.map((n) => n.text.split('\n')[0]),
    edges: res.graph.edges.length,
  });
}

export async function serveStdio(root: string, opts: GenerateOptions = {}): Promise<void> {
  await createServer(root, opts).connect(new StdioServerTransport());
}
