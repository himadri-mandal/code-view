import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Module } from './model.js';

const IGNORE = ['**/node_modules/**', '**/target/**', '**/build/**', '**/.git/**', '**/code-view/**', '**/.gradle/**'];

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
  includeTests?: boolean;
}

export interface ScanResult {
  name: string;
  modules: Module[];
  files: { module: Module; abs: string; rel: string }[];
}

/** Every directory with a src/main/java (Maven or Gradle layout) is a module; plain projects fall back to the root. */
export async function scanProject(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const name = projectName(root);
  const javaRoots = await fg('**/src/main/java', { cwd: root, onlyDirectories: true, ignore: IGNORE });
  const modules: Module[] = javaRoots.sort().map((rel) => {
    const dir = path.resolve(root, rel, '../../..');
    const relDir = path.relative(root, dir);
    const sourceRoots = [path.join(dir, 'src/main/java')];
    if (opts.includeTests && fs.existsSync(path.join(dir, 'src/test/java'))) sourceRoots.push(path.join(dir, 'src/test/java'));
    return {
      name: relDir ? projectName(dir) : name,
      dir,
      sourceRoots,
      resourceRoots: [path.join(dir, 'src/main/resources')].filter((p) => fs.existsSync(p)),
    };
  });
  if (modules.length === 0) modules.push({ name, dir: root, sourceRoots: [root], resourceRoots: [] });

  const files: ScanResult['files'] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    for (const src of module.sourceRoots) {
      const found = await fg(opts.include?.length ? opts.include : ['**/*.java'], {
        cwd: src,
        absolute: true,
        ignore: [...IGNORE, ...(opts.exclude ?? [])],
      });
      for (const abs of found.sort()) {
        if (!abs.endsWith('.java') || seen.has(abs)) continue;
        seen.add(abs);
        files.push({ module, abs, rel: path.relative(root, abs) });
      }
    }
  }
  return { name, modules, files };
}

function projectName(dir: string): string {
  const pom = path.join(dir, 'pom.xml');
  if (fs.existsSync(pom)) {
    const xml = fs.readFileSync(pom, 'utf8').replace(/<parent>[\s\S]*?<\/parent>/, '');
    const m = xml.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
    if (m) return m[1];
  }
  for (const f of ['settings.gradle', 'settings.gradle.kts']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  return path.basename(dir);
}
