import { isAccessor } from '../analyze/resolve.js';
import { INFRA_TYPES, LANES, type ClassInfo, type Lane } from '../analyze/spring.js';
import type { Canvas } from '../canvas/canvas.js';
import { COLORS, Graph, measure } from '../canvas/graph.js';
import { toCanvas } from '../layout/elk.js';
import { simpleName, type Module, type TypeDecl } from '../model.js';
import { entriesOf, entryIcon, link, methodLabel, sourceLink, type ViewContext } from './context.js';

const PAD = 30;
const HEADER = 60;
const GAP = 40;
const COLUMN_GAP = 160;
const MAX_LIST = 8;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Layered component diagram of one module: lanes (columns) → package groups → classes.
 * Uses a deterministic grid so lanes always read left to right.
 */
export function componentsCanvas(ctx: ViewContext, module: Module): Canvas {
  const g = new Graph('RIGHT');
  const boxes = new Map<string, Box>();
  const classes = [...ctx.spring.classes.values()].filter((c) => c.type.module === module.name && !c.type.outer);
  const basePkg = commonPackage(classes.map((c) => c.type.pkg));
  const infraUsed = new Set<string>();

  const laneBoxes = new Map<Lane, { w: number; h: number; place: (x: number, y: number) => void }>();
  for (const lane of LANES) {
    const members = classes.filter((c) => c.lane === lane.id);
    if (!members.length) continue;
    const laneId = `lane:${lane.id}`;
    g.group({ id: laneId, label: lane.title, color: COLORS[lane.id] });
    const byPkg = new Map<string, ClassInfo[]>();
    for (const c of members) byPkg.set(c.type.pkg, [...(byPkg.get(c.type.pkg) ?? []), c]);

    const pkgLayouts: { id: string; w: number; h: number; cells: { id: string; dx: number; dy: number; w: number; h: number }[] }[] = [];
    for (const [pkg, list] of [...byPkg].sort(([a], [b]) => a.localeCompare(b))) {
      const pkgId = `pkg:${lane.id}:${pkg}`;
      g.group({ id: pkgId, label: relPackage(pkg, basePkg), parent: laneId });
      const sized = list
        .sort((a, b) => a.type.name.localeCompare(b.type.name))
        .map((c) => {
          const id = `class:${c.type.fqn}`;
          const text = classText(ctx, c);
          const size = measure(text, 220, 420);
          g.node({ id, text, color: COLORS[c.lane], parent: pkgId, ...size });
          return { id, ...size };
        });
      const cols = sized.length > 6 ? 3 : sized.length > 2 ? 2 : 1;
      const colW = Math.max(...sized.map((s) => s.width));
      const cells: { id: string; dx: number; dy: number; w: number; h: number }[] = [];
      let y = HEADER;
      for (let i = 0; i < sized.length; i += cols) {
        const row = sized.slice(i, i + cols);
        row.forEach((s, j) => cells.push({ id: s.id, dx: PAD + j * (colW + GAP), dy: y, w: s.width, h: s.height }));
        y += Math.max(...row.map((s) => s.height)) + GAP;
      }
      pkgLayouts.push({ id: pkgId, w: PAD * 2 + cols * colW + (cols - 1) * GAP, h: y - GAP + PAD, cells });
    }
    const w = Math.max(...pkgLayouts.map((p) => p.w)) + PAD * 2;
    const h = HEADER + pkgLayouts.reduce((s, p) => s + p.h + GAP, 0) - GAP + PAD;
    laneBoxes.set(lane.id, {
      w,
      h,
      place: (x, y) => {
        boxes.set(laneId, { x, y, width: w, height: h });
        let py = y + HEADER;
        for (const p of pkgLayouts) {
          boxes.set(p.id, { x: x + PAD, y: py, width: w - PAD * 2, height: p.h });
          for (const c of p.cells) boxes.set(c.id, { x: x + PAD + c.dx, y: py + c.dy, width: c.w, height: c.h });
          py += p.h + GAP;
        }
      },
    });
  }

  // Dependency + inheritance edges.
  for (const d of ctx.spring.deps.filter((d) => d.from.module === module.name)) {
    const from = `class:${topLevel(d.from).fqn}`;
    const target = ctx.table.type(d.to);
    if (target) {
      const info = ctx.spring.info(topLevel(target).fqn);
      g.edge({ from, to: `class:${topLevel(target).fqn}`, color: info ? COLORS[info.lane] : undefined, label: d.via === 'bean' ? '@Bean param' : undefined });
    } else if (INFRA_TYPES[d.to]) {
      infraUsed.add(d.to);
      g.edge({ from, to: `infra:${d.to}`, color: COLORS[INFRA_TYPES[d.to]] });
    }
  }
  for (const c of classes) {
    for (const s of c.type.supertypes) {
      const sup = ctx.table.type(s);
      if (sup && sup.module === module.name) {
        g.edge({ from: `class:${c.type.fqn}`, to: `class:${topLevel(sup).fqn}`, label: sup.kind === 'interface' && c.type.kind !== 'interface' ? 'implements' : 'extends', color: COLORS.other });
      }
    }
    if (c.lane === 'model') {
      for (const f of c.type.fields) {
        const ref = [f.type, ...(f.type.match(/<(.+)>/)?.[1].split(',') ?? [])].map((x) => ctx.table.type(ctx.table.resolveType(x.trim(), c.type))).find(Boolean);
        if (ref && ref !== c.type && ref.module === module.name && ctx.spring.info(ref.fqn)?.lane === 'model') {
          g.edge({ from: `class:${c.type.fqn}`, to: `class:${topLevel(ref).fqn}`, label: `has ${f.name}`, color: COLORS.model });
        }
      }
    }
  }

  // Infrastructure column.
  let infraBox: { w: number; h: number; place: (x: number, y: number) => void } | undefined;
  if (infraUsed.size) {
    g.group({ id: 'lane:infra', label: 'Infrastructure (library beans)', color: COLORS.other });
    const items = [...infraUsed].sort().map((name) => {
      const text = `### ${name}\n${infraBlurb(INFRA_TYPES[name])}`;
      const size = measure(text, 200, 320);
      g.node({ id: `infra:${name}`, text, color: COLORS[INFRA_TYPES[name]], parent: 'lane:infra', ...size });
      return { id: `infra:${name}`, ...size };
    });
    const w = Math.max(...items.map((i) => i.width)) + PAD * 2;
    const h = HEADER + items.reduce((s, i) => s + i.height + GAP, 0) - GAP + PAD;
    infraBox = {
      w,
      h,
      place: (x, y) => {
        boxes.set('lane:infra', { x, y, width: w, height: h });
        let iy = y + HEADER;
        for (const i of items) {
          boxes.set(i.id, { x: x + PAD, y: iy, width: i.width, height: i.height });
          iy += i.height + GAP;
        }
      },
    };
  }

  // Title row, then the main lanes left→right, then config/other underneath.
  const title = `# ${module.name} — components\n${link(ctx.paths.index, '← system overview')}${ctx.kafka.used ? ` · ${link(ctx.paths.events, 'Kafka event map')}` : ''}\nArrows point from a class to what it depends on (injection), or to its supertype.`;
  g.node({ id: 'title', text: title, ...measure(title, 400, 900) });
  boxes.set('title', { x: 0, y: 0, ...measure(title, 400, 900) });
  const top = 200;
  let x = 0;
  let maxH = 0;
  for (const lane of ['inbound', 'service', 'outbound', 'model'] as Lane[]) {
    const lb = laneBoxes.get(lane);
    if (!lb) continue;
    lb.place(x, top);
    x += lb.w + COLUMN_GAP;
    maxH = Math.max(maxH, lb.h);
  }
  if (infraBox) {
    infraBox.place(x, top);
    maxH = Math.max(maxH, infraBox.h);
  }
  x = 0;
  for (const lane of ['config', 'other'] as Lane[]) {
    const lb = laneBoxes.get(lane);
    if (!lb) continue;
    lb.place(x, top + maxH + COLUMN_GAP);
    x += lb.w + COLUMN_GAP;
  }
  return toCanvas(g, `components:${module.name}`, boxes);
}

function classText(ctx: ViewContext, c: ClassInfo): string {
  const t = c.type;
  const lines = [`### ${t.name}`, `\`${c.stereotype}\``];
  const entryLines = t.methods.flatMap((m) => entriesOf(ctx, m).map((e) => `- ${entryIcon(e)} ${link(ctx.paths.flow(e), e.trigger.length > 40 ? `${e.trigger.slice(0, 39)}…` : e.trigger)}`));
  if (entryLines.length) lines.push(...entryLines.slice(0, MAX_LIST * 2), ...(entryLines.length > MAX_LIST * 2 ? [`- … ${entryLines.length - MAX_LIST * 2} more`] : []));
  else if (c.lane === 'model') {
    const fields = t.fields.filter((f) => !f.modifiers.includes('static'));
    lines.push(...fields.slice(0, MAX_LIST).map((f) => `- ${f.name}: ${simpleName(f.type)}`), ...(fields.length > MAX_LIST ? [`- … ${fields.length - MAX_LIST} more`] : []));
  } else {
    const methods = t.methods.filter((m) => !m.isConstructor && !isAccessor(m) && !m.modifiers.includes('private'));
    lines.push(
      ...methods.slice(0, MAX_LIST).map((m) => `- ${ctx.cfgMethods.has(m) ? link(ctx.paths.method(m), methodLabel(m)) : methodLabel(m)}`),
      ...(methods.length > MAX_LIST ? [`- … ${methods.length - MAX_LIST} more`] : []),
    );
  }
  lines.push(sourceLink(ctx, t, t.line));
  return lines.join('\n');
}

function infraBlurb(kind: string): string {
  return { kafka: 'Kafka producer', http: 'HTTP client', db: 'Database access', llm: 'Spring AI model client', vector: 'Spring AI vector store' }[kind] ?? '';
}

function topLevel(t: TypeDecl): TypeDecl {
  let o = t;
  while (o.outer) o = o.outer;
  return o;
}

function commonPackage(pkgs: string[]): string {
  if (!pkgs.length) return '';
  let parts = pkgs[0].split('.');
  for (const p of pkgs) {
    const q = p.split('.');
    let i = 0;
    while (i < parts.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('.');
}

function relPackage(pkg: string, base: string): string {
  if (pkg === base) return pkg.split('.').pop() || '(default package)';
  return pkg.startsWith(`${base}.`) ? pkg.slice(base.length + 1) : pkg;
}
