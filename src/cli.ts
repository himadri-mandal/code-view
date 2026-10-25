#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { FactsIndex } from './facts/index.js';
import { analyze, generate } from './generate.js';
import { serveStdio } from './mcp/server.js';
import { ViewStore } from './spec/registry.js';
import type { Editor } from './views/context.js';

const list = (v: string, prev: string[] = []) => [...prev, ...v.split(',').map((s) => s.trim()).filter(Boolean)];

const program = new Command()
  .name('java-canvas')
  .description('Generate linked JSON Canvas diagrams (components, Kafka event map, call flows, method flowcharts) for a Java / Spring Boot project')
  .argument('[projectDir]', 'Java project root', '.')
  .option('-o, --out <dir>', 'output directory (default: <projectDir>/code-view)')
  .option('-p, --profile <names>', 'Spring profiles whose application-<profile>.yml/properties to merge', list)
  .option('-d, --depth <n>', 'max call depth per flow', (v) => parseInt(v, 10), 6)
  .option('--max-steps <n>', 'max calls drawn per flow', (v) => parseInt(v, 10), 60)
  .option('-e, --entry <filters>', 'only trace entry points whose id/trigger contains one of these', list)
  .option('--methods <mode>', 'method flowcharts: flows | all | none', 'flows')
  .option('--include <globs>', 'only parse matching source files (relative to each source root)', list)
  .option('--exclude <globs>', 'skip matching source files', list)
  .option('--include-tests', 'also parse src/test/java')
  .option('--include-accessors', 'keep getters/setters in call flows')
  .option('--editor <name>', 'source links: vscode | cursor | idea | none', 'vscode')
  .option('--relayout', 'ignore existing canvases and lay out from scratch (default: keep node positions)')
  .action(async (dir: string, o) => {
    const started = Date.now();
    const res = await generate(path.resolve(dir), {
      out: o.out,
      profiles: o.profile,
      depth: o.depth,
      maxSteps: o.maxSteps,
      entries: o.entry,
      methods: o.methods,
      include: o.include,
      exclude: o.exclude,
      includeTests: !!o.includeTests,
      includeAccessors: !!o.includeAccessors,
      editor: o.editor as Editor,
      relayout: !!o.relayout,
      log: (m) => console.log(`  ${m}`),
    });
    const s = res.stats;
    console.log(`✔ ${res.files.length} files → ${path.relative(process.cwd(), res.outDir) || '.'}`);
    console.log(`  ${s.types} types · ${s.entries} entry points · ${s.topics} Kafka topics · ${s.flows} flows · ${s.methods} method flowcharts · ${Date.now() - started} ms`);
  });

program
  .command('mcp')
  .description('Run an MCP server (stdio) so an LLM client can explore the project and design canvases')
  .argument('[projectDir]', 'Java project root', '.')
  .option('-o, --out <dir>', 'output directory (default: <projectDir>/code-view)')
  .option('-p, --profile <names>', 'Spring profiles to merge', list)
  .option('--include-tests', 'also parse src/test/java')
  .option('--editor <name>', 'source links: vscode | cursor | idea | none', 'vscode')
  .action(async (dir: string, o) => {
    await serveStdio(path.resolve(dir), { out: o.out, profiles: o.profile, includeTests: !!o.includeTests, editor: o.editor as Editor });
  });

program
  .command('render')
  .description('Re-render the saved view specs (<out>/specs/*.view.yaml) from the current code, without an LLM')
  .argument('[projectDir]', 'Java project root', '.')
  .option('-o, --out <dir>', 'output directory (default: <projectDir>/code-view)')
  .option('-p, --profile <names>', 'Spring profiles to merge', list)
  .option('--editor <name>', 'source links: vscode | cursor | idea | none', 'vscode')
  .option('--relayout', 'ignore existing canvases and lay out from scratch')
  .action(async (dir: string, o) => {
    const root = path.resolve(dir);
    const store = new ViewStore(path.resolve(o.out ?? path.join(root, 'code-view')));
    const views = store.list();
    if (!views.length) return console.log('no saved views');
    const facts = new FactsIndex(await analyze(root, { profiles: o.profile }));
    let failed = false;
    for (const v of views) {
      const { spec, errors } = store.read(v.name);
      const res = spec ? await store.render(spec, facts, { editor: o.editor as Editor, relayout: !!o.relayout }) : { errors, warnings: [], changes: undefined };
      if (res.errors.length) {
        failed = true;
        console.log(`✘ ${v.name}: ${res.errors.join('; ')}`);
        continue;
      }
      const c = res.changes!;
      console.log(`✔ ${v.name} → ${v.canvas}  (+${c.added.length} −${c.removed.length} ~${c.changed.length})`);
      for (const w of res.warnings) console.log(`  ⚠ ${w}`);
    }
    if (failed) process.exitCode = 1;
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
