import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateCanvas, type Canvas } from '../canvas/canvas.js';
import type { FactsIndex } from '../facts/index.js';
import { anchorCanvas, type ChangeReport } from '../layout/anchor.js';
import { applyTheme, loadTheme } from '../theme/index.js';
import type { Editor } from '../views/context.js';
import { compileView } from './compile.js';
import { parseSpec, type ViewSpec } from './schema.js';

export interface ViewInfo {
  name: string;
  title: string;
  question?: string;
  spec: string;
  canvas: string;
}

export interface RenderOptions {
  editor?: Editor;
  strict?: boolean;
  /** Ignore the previous canvas and lay everything out from scratch. */
  relayout?: boolean;
}

export interface RenderResult {
  name: string;
  canvas?: string;
  nodes: number;
  errors: string[];
  warnings: string[];
  changes?: ChangeReport;
}

/** Saved view specs live in `<outDir>/specs/<name>.view.yaml`; their canvases in `<outDir>/views/<name>.canvas`. */
export class ViewStore {
  constructor(readonly outDir: string) {}

  specFile(name: string): string {
    return path.join(this.outDir, 'specs', `${name}.view.yaml`);
  }

  canvasRel(name: string): string {
    return `views/${name}.canvas`;
  }

  list(): ViewInfo[] {
    const dir = path.join(this.outDir, 'specs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.view.yaml')).sort().flatMap((f) => {
      const name = f.slice(0, -'.view.yaml'.length);
      const raw = this.raw(name) as Partial<ViewSpec> | undefined;
      if (!raw) return [];
      return [{ name, title: raw.title ?? name, question: raw.question, spec: path.relative(this.outDir, this.specFile(name)), canvas: this.canvasRel(name) }];
    });
  }

  raw(name: string): unknown {
    const file = this.specFile(name);
    return fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : undefined;
  }

  read(name: string): { spec?: ViewSpec; errors: string[] } {
    const raw = this.raw(name);
    if (raw === undefined) return { errors: [`no view named ${name}`] };
    return parseSpec(raw);
  }

  write(spec: ViewSpec): void {
    const file = this.specFile(spec.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(spec, { lineWidth: 0 }));
  }

  /** Views ranked by word overlap between `question` and each view's name, title and question. */
  find(question: string, limit = 5): (ViewInfo & { score: number })[] {
    const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
    const q = words(question);
    if (!q.size) return [];
    return this.list()
      .map((v) => {
        const w = words(`${v.name.replace(/-/g, ' ')} ${v.title} ${v.question ?? ''}`);
        const common = [...q].filter((x) => w.has(x)).length;
        return { ...v, score: Math.round((common / new Set([...q, ...w]).size) * 100) / 100 };
      })
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  previous(rel: string): Canvas | undefined {
    const file = path.join(this.outDir, rel);
    try {
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Canvas) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Compiles a spec, keeps the previous canvas's positions, and writes it. Does not save the spec. */
  async render(spec: ViewSpec, facts: FactsIndex, opts: RenderOptions = {}): Promise<RenderResult> {
    const exists = (rel: string) => fs.existsSync(path.join(this.outDir, rel));
    const res = await compileView(spec, facts, { editor: opts.editor, strict: opts.strict, exists });
    if (!res.canvas) return { name: spec.name, nodes: res.nodes, errors: res.errors, warnings: res.warnings };
    const rel = this.canvasRel(spec.name);
    const themed = applyTheme(res.canvas, loadTheme(this.outDir));
    const { canvas, report } = anchorCanvas(themed, opts.relayout ? undefined : this.previous(rel));
    const invalid = validateCanvas(canvas);
    if (invalid.length) return { name: spec.name, nodes: res.nodes, errors: invalid.slice(0, 5), warnings: res.warnings };
    writeCanvas(this.outDir, rel, canvas);
    return { name: spec.name, canvas: rel, nodes: res.nodes, errors: [], warnings: res.warnings, changes: report };
  }
}

export function writeCanvas(outDir: string, rel: string, canvas: Canvas): void {
  const abs = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(canvas, null, '\t')}\n`);
}

/** RFC 7386 JSON merge patch: objects merge recursively, `null` deletes, anything else (arrays too) replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'show', 'with', 'from', 'into', 'does', 'that', 'this', 'are', 'view', 'canvas', 'diagram']);
