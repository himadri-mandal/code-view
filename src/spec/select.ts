import type { FactsIndex, FactKind } from '../facts/index.js';
import type { Selector } from './schema.js';

const ID_PREFIX = /^(type|method|entry|topic|ext):/;
const FILTERS = ['kind', 'role', 'module', 'package', 'name'] as const;

export interface Resolution {
  ids: Set<string>;
  /** Exact ids that do not exist (e.g. after a rename). */
  unknown: string[];
  /** Selectors that matched nothing. */
  empty: string[];
}

/** Resolves selectors against the facts. Deterministic: the same facts and selectors give the same set. */
export function resolve(facts: FactsIndex, selectors: Selector[]): Resolution {
  const res: Resolution = { ids: new Set(), unknown: [], empty: [] };
  for (const s of selectors) for (const id of one(facts, s, res)) res.ids.add(id);
  return res;
}

function one(facts: FactsIndex, s: Selector, res: Resolution): Set<string> {
  const out = match(facts, s, res);
  if (!out.size && !(typeof s === 'string' && res.unknown.includes(s))) res.empty.push(typeof s === 'string' ? s : JSON.stringify(s));
  return out;
}

function match(facts: FactsIndex, s: Selector, res: Resolution): Set<string> {
  if (typeof s !== 'string') {
    if ('all' in s) {
      const sets = s.all.map((x) => one(facts, x, res));
      return new Set([...sets[0]].filter((id) => sets.every((set) => set.has(id))));
    }
    if ('any' in s) return new Set(s.any.flatMap((x) => [...one(facts, x, res)]));
    if ('methodsOf' in s) {
      const owners = one(facts, s.methodsOf, res);
      return new Set([...facts.facts.values()].filter((f) => f.kind === 'method' && owners.has(f.owner!)).map((f) => f.id));
    }
    const r = s.reachable;
    const from = (Array.isArray(r.from) ? r.from : [r.from]).flatMap((x) => [...one(facts, x, res)]);
    return facts.reachable(from, r.depth ?? 4, r.via ?? ['triggers', 'calls', 'produces', 'consumes', 'uses'], r.both);
  }

  if (ID_PREFIX.test(s)) {
    if (!s.includes('*')) {
      if (facts.get(s)) return new Set([s]);
      res.unknown.push(s);
      return new Set();
    }
    const re = glob(s, false);
    return new Set([...facts.facts.keys()].filter((id) => re.test(id)));
  }
  const [key, ...rest] = s.split(':');
  const value = rest.join(':');
  if (!FILTERS.includes(key as (typeof FILTERS)[number]) || !value) {
    throw new Error(`bad selector "${s}": use an id (type:/method:/entry:/topic:/ext:) or ${FILTERS.map((f) => `${f}:`).join(' ')}`);
  }
  const out = new Set<string>();
  const re = glob(value, key === 'package', key === 'name');
  for (const f of facts.facts.values()) {
    const ok =
      key === 'kind' ? f.kind === (value as FactKind) :
      key === 'role' ? f.role === value :
      key === 'module' ? !!f.module && re.test(f.module) :
      key === 'package' ? !!f.pkg && re.test(f.pkg) :
      re.test(f.name);
    if (ok) out.add(f.id);
  }
  return out;
}

/** `**` matches anything; `*` matches anything except `.` in package globs and anything elsewhere. */
function glob(pattern: string, dotted: boolean, ci = false): RegExp {
  const body = pattern
    .split('**')
    .map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(dotted ? '[^.]*' : '.*'))
    .join('.*');
  return new RegExp(`^${body}$`, ci ? 'i' : '');
}
