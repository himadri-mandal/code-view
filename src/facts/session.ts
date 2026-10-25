import fs from 'node:fs';
import path from 'node:path';
import { analyze, type GenerateOptions } from '../generate.js';
import { scanProject } from '../scan.js';
import { FactsIndex } from './index.js';

/** Long-lived handle on one project: re-analyzes only when a source or config file changed. */
export class ProjectSession {
  readonly root: string;
  readonly outDir: string;
  private cached?: { stamp: string; facts: FactsIndex };

  constructor(root: string, readonly opts: GenerateOptions = {}) {
    this.root = path.resolve(root);
    this.outDir = path.resolve(opts.out ?? path.join(this.root, 'code-view'));
  }

  async facts(): Promise<FactsIndex> {
    const stamp = await this.stamp();
    if (this.cached?.stamp !== stamp) this.cached = { stamp, facts: new FactsIndex(await analyze(this.root, this.opts)) };
    return this.cached.facts;
  }

  /** Paths, sizes and mtimes of every parsed source and resource file. */
  private async stamp(): Promise<string> {
    const scan = await scanProject(this.root, this.opts);
    const files = [...scan.files.map((f) => f.abs), ...scan.modules.flatMap((m) => m.resourceRoots.flatMap((r) => fs.readdirSync(r).map((f) => path.join(r, f))))];
    return files.sort().map((f) => {
      const s = fs.statSync(f);
      return `${f}:${s.size}:${s.mtimeMs}`;
    }).join('\n');
  }
}
