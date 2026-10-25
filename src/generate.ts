import fs from 'node:fs';
import path from 'node:path';
import { CallGraph, type Flow } from './analyze/callgraph.js';
import { complexity } from './analyze/cfg.js';
import { Externals } from './analyze/externals.js';
import { KafkaModel } from './analyze/kafka.js';
import { linkCalls, SymbolTable } from './analyze/resolve.js';
import { SpringModel, type EntryPoint } from './analyze/spring.js';
import { validateCanvas, type Canvas } from './canvas/canvas.js';
import { loadConfig } from './config.js';
import { FactsIndex } from './facts/index.js';
import { anchorCanvas } from './layout/anchor.js';
import type { MethodDecl, Project, TypeDecl } from './model.js';
import { extractTypes } from './parse/extract.js';
import { getParser } from './parse/parser.js';
import { scanProject, type ScanOptions } from './scan.js';
import { ViewStore, writeCanvas, type RenderResult } from './spec/registry.js';
import { applyTheme, loadTheme } from './theme/index.js';
import { componentsCanvas } from './views/components.js';
import { Paths, type Editor, type ViewContext } from './views/context.js';
import { flowCanvas } from './views/flow.js';
import { methodCanvas } from './views/method.js';
import { eventsCanvas, indexCanvas } from './views/overview.js';
import { readme } from './views/readme.js';

export interface GenerateOptions extends ScanOptions {
  out?: string;
  profiles?: string[];
  depth?: number;
  maxSteps?: number;
  includeAccessors?: boolean;
  /** Which methods get a flowchart canvas. */
  methods?: 'flows' | 'all' | 'none';
  /** Only trace entry points whose id or trigger contains one of these strings. */
  entries?: string[];
  editor?: Editor;
  clean?: boolean;
  /** Ignore previous canvases and lay everything out from scratch (default: keep existing node positions). */
  relayout?: boolean;
  /** Also re-render the saved view specs in `<out>/specs` (default true). */
  views?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateResult {
  outDir: string;
  files: string[];
  views: RenderResult[];
  stats: { types: number; entries: number; topics: number; flows: number; methods: number; ms: number };
}

export async function analyze(root: string, opts: GenerateOptions = {}) {
  const scan = await scanProject(root, opts);
  const parser = await getParser();
  const types = new Map<string, TypeDecl>();
  for (const f of scan.files) {
    const tree = parser.parse(fs.readFileSync(f.abs, 'utf8'));
    if (!tree) continue;
    for (const t of extractTypes(tree.rootNode, { module: f.module.name, file: f.rel, absFile: f.abs })) types.set(t.fqn, t);
  }
  const project: Project = {
    root,
    name: scan.name,
    modules: scan.modules,
    types,
    config: new Map(scan.modules.map((m) => [m.name, loadConfig(m, opts.profiles)])),
  };
  const table = new SymbolTable(project);
  linkCalls(table);
  const spring = new SpringModel(table);
  const kafka = new KafkaModel(table);
  const externals = new Externals(table, spring);
  const calls = new CallGraph(table, spring, kafka, externals, {
    depth: opts.depth ?? 6,
    includeAccessors: opts.includeAccessors ?? false,
    maxSteps: opts.maxSteps ?? 60,
  });
  return { project, table, spring, kafka, externals, calls };
}

export async function generate(projectDir: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const root = path.resolve(projectDir);
  const outDir = path.resolve(opts.out ?? path.join(root, 'code-view'));
  const a = await analyze(root, opts);
  log(`parsed ${a.project.types.size} types in ${a.project.modules.length} module(s)`);

  const selected = a.spring.entries.filter((e) => !opts.entries?.length || opts.entries.some((s) => e.id.includes(s) || e.trigger.includes(s)));
  const flows = new Map<EntryPoint, Flow>(selected.map((e) => [e, a.calls.trace(e)]));
  const cfgMethods = pickCfgMethods(a.project, flows, opts.methods ?? 'flows');
  const ctx: ViewContext = { ...a, flows, cfgMethods, paths: new Paths(), editor: opts.editor ?? 'vscode' };

  const store = new ViewStore(outDir);
  const theme = loadTheme(outDir);
  // Read the previous canvases before cleaning so unchanged nodes keep their place.
  const previous = new Map<string, Canvas | undefined>();
  const prev = (rel: string) => {
    if (!previous.has(rel)) previous.set(rel, opts.relayout ? undefined : store.previous(rel));
    return previous.get(rel);
  };
  if (fs.existsSync(outDir)) for (const f of fs.readdirSync(outDir, { recursive: true }) as string[]) if (f.endsWith('.canvas')) prev(f.split(path.sep).join('/'));
  if (opts.clean !== false) for (const d of ['components', 'flows', 'methods']) fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
  const files: string[] = [];
  const write = (rel: string, fresh: Canvas) => {
    const { canvas } = anchorCanvas(applyTheme(fresh, theme), prev(rel));
    const errors = validateCanvas(canvas);
    if (errors.length) throw new Error(`invalid canvas ${rel}: ${errors.slice(0, 3).join('; ')}`);
    writeCanvas(outDir, rel, canvas);
    files.push(rel);
  };

  write(ctx.paths.index, await indexCanvas(ctx));
  if (a.kafka.used) write(ctx.paths.events, await eventsCanvas(ctx));
  for (const m of a.project.modules) write(ctx.paths.component(m.name), componentsCanvas(ctx, m));
  for (const flow of flows.values()) write(ctx.paths.flow(flow.entry), await flowCanvas(ctx, flow));
  for (const m of cfgMethods) write(ctx.paths.method(m), await methodCanvas(ctx, m));
  fs.writeFileSync(path.join(outDir, 'README.md'), readme(ctx));
  files.push('README.md');

  const views: RenderResult[] = [];
  if (opts.views !== false && store.list().length) {
    const facts = new FactsIndex(a);
    for (const v of store.list()) {
      const { spec, errors } = store.read(v.name);
      const res = spec ? await store.render(spec, facts, { editor: opts.editor, relayout: opts.relayout }) : { name: v.name, nodes: 0, errors, warnings: [] };
      views.push(res);
      if (res.canvas) files.push(res.canvas);
      for (const e of res.errors) log(`view ${v.name}: ${e}`);
      for (const w of res.warnings) log(`view ${v.name}: ${w}`);
    }
  }

  return {
    outDir,
    files,
    views,
    stats: {
      types: a.project.types.size,
      entries: a.spring.entries.length,
      topics: a.kafka.topics.size,
      flows: flows.size,
      methods: cfgMethods.size,
      ms: Date.now() - started,
    },
  };
}

function pickCfgMethods(project: Project, flows: Map<EntryPoint, Flow>, mode: 'flows' | 'all' | 'none'): Set<MethodDecl> {
  if (mode === 'none') return new Set();
  const worth = (m: MethodDecl) => !!m.body && (complexity(m) >= 2 || m.body.namedChildren.length >= 3);
  const candidates = mode === 'all'
    ? [...project.types.values()].flatMap((t) => t.methods)
    : [...flows.values()].flatMap((f) => f.methods);
  return new Set(candidates.filter(worth));
}
