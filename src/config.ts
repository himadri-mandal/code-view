import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Module } from './model.js';

/** Loads application.{properties,yml,yaml} plus application-<profile>.* (profile wins) into one flat map. */
export function loadConfig(module: Module, profiles: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const suffix of ['', ...profiles.map((p) => `-${p}`)]) {
    for (const dir of module.resourceRoots) {
      for (const ext of ['properties', 'yml', 'yaml']) {
        const file = path.join(dir, `application${suffix}.${ext}`);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (ext === 'properties') Object.assign(out, parseProperties(text));
        else for (const doc of YAML.parseAllDocuments(text)) flatten(doc.toJS(), '', out);
      }
    }
  }
  for (const [k, v] of Object.entries(out)) out[k] = resolvePlaceholders(v, out);
  return out;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    out[prefix] = value.filter((v) => typeof v !== 'object').join(',');
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = String(value);
  }
}

/** Resolves ${key:default} placeholders; unknown keys without defaults are kept verbatim. */
export function resolvePlaceholders(value: string, config: Record<string, string>, depth = 0): string {
  if (depth > 10) return value;
  return value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (whole, key: string, def?: string) => {
    const hit = config[key.trim()];
    if (hit !== undefined) return resolvePlaceholders(hit, config, depth + 1);
    return def !== undefined ? def : whole;
  });
}
