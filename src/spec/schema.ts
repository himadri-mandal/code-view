import { z } from 'zod';
import { EDGE_KINDS } from '../facts/index.js';

/**
 * A selector picks facts. Strings:
 * - an id (`type:…`, `method:…`, `entry:…`, `topic:…`, `ext:…`), exact or with `*` globs
 * - `kind:<type|method|entry|topic|external>`, `role:<lane|entry kind|kafka|dlt|db|llm|http|vector>`
 * - `module:<glob>`, `package:<glob>` (`*` = one segment, `**` = any), `name:<glob>` (case-insensitive)
 * Objects combine them: `{ reachable: { from, depth, via, both } }`, `{ methodsOf: sel }`, `{ all: [...] }`, `{ any: [...] }`.
 */
export type Selector =
  | string
  | { reachable: { from: Selector | Selector[]; depth?: number; via?: (typeof EDGE_KINDS)[number][]; both?: boolean } }
  | { methodsOf: Selector }
  | { all: Selector[] }
  | { any: Selector[] };

export const SelectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.object({
      reachable: z.object({
        from: z.union([SelectorSchema, z.array(SelectorSchema)]),
        depth: z.number().int().min(1).max(12).optional(),
        via: z.array(z.enum(EDGE_KINDS)).optional(),
        both: z.boolean().optional(),
      }).strict(),
    }).strict(),
    z.object({ methodsOf: SelectorSchema }).strict(),
    z.object({ all: z.array(SelectorSchema).min(1) }).strict(),
    z.object({ any: z.array(SelectorSchema).min(1) }).strict(),
  ]),
);

export const GROUP_LEVELS = ['module', 'package', 'lane', 'class'] as const;

const asArray = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.array(t)]).transform((v) => (Array.isArray(v) ? v : [v]) as z.infer<T>[]);

/** Declarative description of one canvas. It says what to show; layout, ids and colors are derived. */
export const ViewSpecSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'kebab-case, max 64 chars'),
  title: z.string().min(1),
  /** The question the view answers, used to find the view again. */
  question: z.string().optional(),
  direction: z.enum(['RIGHT', 'DOWN']).default('RIGHT'),
  include: z.array(SelectorSchema).min(1),
  exclude: z.array(SelectorSchema).default([]),
  edges: z.array(z.enum(EDGE_KINDS)).default(['triggers', 'calls', 'produces', 'consumes', 'uses']),
  groupBy: asArray(z.enum(GROUP_LEVELS)).default(['class']),
  groups: z.array(z.object({
    id: z.string().regex(/^[\w-]+$/),
    label: z.string(),
    members: z.array(SelectorSchema).min(1),
  }).strict()).default([]),
  detail: z.enum(['low', 'medium', 'high']).default('medium'),
  annotations: z.record(z.string(), z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    emphasis: z.enum(['highlight', 'muted']).optional(),
  }).strict()).default({}),
  notes: z.array(z.object({ text: z.string().min(1), attach: z.string().optional() }).strict()).default([]),
  maxNodes: z.number().int().min(1).max(400).default(80),
}).strict();

export type ViewSpec = z.output<typeof ViewSpecSchema>;
export type ViewSpecInput = z.input<typeof ViewSpecSchema>;

export function parseSpec(raw: unknown): { spec?: ViewSpec; errors: string[] } {
  const r = ViewSpecSchema.safeParse(raw);
  if (r.success) return { spec: r.data, errors: [] };
  return { errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
