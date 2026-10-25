#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { generate } from './generate.js';
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
      log: (m) => console.log(`  ${m}`),
    });
    const s = res.stats;
    console.log(`✔ ${res.files.length} files → ${path.relative(process.cwd(), res.outDir) || '.'}`);
    console.log(`  ${s.types} types · ${s.entries} entry points · ${s.topics} Kafka topics · ${s.flows} flows · ${s.methods} method flowcharts · ${Date.now() - started} ms`);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
