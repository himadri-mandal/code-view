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
import type { MethodDecl, Project, TypeDecl } from './model.js';
import { extractTypes } from './parse/extract.js';
import { getParser } from './parse/parser.js';
import { scanProject, type ScanOptions } from './scan.js';
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
  log?: (msg: string) => void;
}

export interface GenerateResult {
  outDir: string;
  files: string[];
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

  if (opts.clean !== false) for (const d of ['components', 'flows', 'methods']) fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
  const files: string[] = [];
  const write = (rel: string, canvas: Canvas) => {
    const errors = validateCanvas(canvas);
    if (errors.length) throw new Error(`invalid canvas ${rel}: ${errors.slice(0, 3).join('; ')}`);
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(canvas, null, '\t')}\n`);
    files.push(rel);
  };

  write(ctx.paths.index, await indexCanvas(ctx));
  if (a.kafka.used) write(ctx.paths.events, await eventsCanvas(ctx));
  for (const m of a.project.modules) write(ctx.paths.component(m.name), componentsCanvas(ctx, m));
  for (const flow of flows.values()) write(ctx.paths.flow(flow.entry), await flowCanvas(ctx, flow));
  for (const m of cfgMethods) write(ctx.paths.method(m), await methodCanvas(ctx, m));
  fs.writeFileSync(path.join(outDir, 'README.md'), readme(ctx));
  files.push('README.md');

  return {
    outDir,
    files,
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
