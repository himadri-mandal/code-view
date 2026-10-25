import { describe, expect, it } from 'vitest';
import { buildCfg } from '../src/analyze/cfg.js';
import { extractTypes } from '../src/parse/extract.js';
import { getParser } from '../src/parse/parser.js';

async function method(body: string) {
  const parser = await getParser();
  const tree = parser.parse(`class A { void m(int x) { ${body} } }`)!;
  const [type] = extractTypes(tree.rootNode, { module: 'm', file: 'A.java', absFile: '/A.java' });
  return type.methods[0];
}

const label = (cfg: ReturnType<typeof buildCfg>, id: string) => cfg.nodes.find((n) => n.id === id)!.lines[0];
const edges = (cfg: ReturnType<typeof buildCfg>) => cfg.edges.map((e) => `${label(cfg, e.from)} -> ${label(cfg, e.to)}${e.label ? ` [${e.label}]` : ''}${e.back ? ' (back)' : ''}`);

describe('control-flow graph', () => {
  it('merges straight-line statements and branches on if/else', async () => {
    const cfg = buildCfg(await method('int a = 1; a++; if (a > x) { foo(); } else { return; } bar();'));
    const block = cfg.nodes.find((n) => n.lines[0] === 'int a = 1;')!;
    expect(block.lines).toEqual(['int a = 1;', 'a++;']);
    expect(edges(cfg)).toEqual(expect.arrayContaining([
      'int a = 1; -> if (a > x)',
      'if (a > x) -> foo(); [true]',
      'if (a > x) -> return [false]',
      'return -> end',
      'foo(); -> end',
    ]));
    // bar() is reachable only through the then-branch, so it joins that block.
    expect(cfg.nodes.find((n) => n.lines[0] === 'foo();')!.lines).toEqual(['foo();', 'bar();']);
  });

  it('draws loop back edges, break and continue', async () => {
    const cfg = buildCfg(await method('for (int i = 0; i < x; i++) { if (i == 2) continue; if (i == 5) break; work(i); } done();'));
    const e = edges(cfg);
    expect(e).toContain('work(i); -> for (int i = 0; i < x; i++) (back)');
    expect(e).toContain('if (i == 2) -> for (int i = 0; i < x; i++) [true] (back)');
    expect(e).toContain('if (i == 5) -> done(); [true]');
    expect(e).toContain('for (int i = 0; i < x; i++) -> done(); [false]');
  });

  it('models try/catch/finally and switch rules', async () => {
    const cfg = buildCfg(await method('try { risky(); } catch (IOException e) { log(e); } finally { close(); } switch (x) { case 1 -> one(); default -> other(); }'));
    const e = edges(cfg);
    expect(e).toContain('try -> catch (IOException e) [throws]');
    expect(e).toContain('risky(); -> finally');
    expect(e).toContain('log(e); -> finally');
    expect(e).toContain('switch (x) -> one(); [case 1]');
    expect(e).toContain('switch (x) -> other(); [default]');
    expect(e.filter((x) => x.endsWith('-> end'))).toEqual(['one(); -> end', 'other(); -> end']);
  });

  it('handles do/while', async () => {
    const cfg = buildCfg(await method('do { x--; } while (x > 0); end();'));
    expect(edges(cfg)).toEqual(expect.arrayContaining(['while (x > 0) -> do [true] (back)', 'while (x > 0) -> end(); [false]']));
  });
});
