import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FactsIndex } from '../src/facts/index.js';
import { analyze, generate } from '../src/generate.js';
import { createServer } from '../src/mcp/server.js';
import { compileView } from '../src/spec/compile.js';
import { ViewStore } from '../src/spec/registry.js';
import { parseSpec, type ViewSpecInput } from '../src/spec/schema.js';
import { resolve } from '../src/spec/select.js';
import { FIXTURES, readCanvas, texts, tmpOut } from './helpers.js';

const KAFKA = path.join(FIXTURES, 'kafka-mini');
const SERVICE = 'type:demo.orders.domain.OrderService';
const FLOW: ViewSpecInput = {
  name: 'order-to-shipping',
  title: 'How an order reaches shipping',
  question: 'how does an order reach shipping',
  include: [{ reachable: { from: 'entry:OrderController.create', depth: 6 } }],
  groupBy: ['module', 'class'],
};
const spec = (raw: ViewSpecInput) => {
  const r = parseSpec(raw);
  expect(r.errors).toEqual([]);
  return r.spec!;
};

/** A writable copy of kafka-mini so tests can edit sources. */
function copyFixture(): string {
  const dir = tmpOut('kafka-copy');
  fs.cpSync(KAFKA, dir, { recursive: true });
  return dir;
}

describe('facts and selectors', async () => {
  const facts = new FactsIndex(await analyze(KAFKA));

  it('indexes every kind with stable ids and edges across Kafka', () => {
    expect(facts.get(SERVICE)).toMatchObject({ kind: 'type', role: 'service', module: 'orders-service' });
    expect(facts.get('topic:orders.v1-dlt')).toMatchObject({ role: 'dlt' });
    expect(facts.outgoing('topic:orders.v1', ['consumes']).map((e) => e.to)).toContain('entry:ShippingListener.onOrder');
    expect(facts.search('OrderService')[0].id).toBe(SERVICE);
  });

  it('resolves string, glob and combined selectors', () => {
    const ids = (s: Parameters<typeof resolve>[1]) => [...resolve(facts, s).ids].sort();
    expect(ids(['type:demo.orders.api.*'])).toEqual(['type:demo.orders.api.OrderController', 'type:demo.orders.api.OrderRequest']);
    expect(ids(['package:demo.shipping'])).toEqual(expect.arrayContaining(['type:demo.shipping.ShippingListener']));
    expect(ids([{ all: ['kind:type', 'role:service'] }])).toEqual(['type:demo.orders.domain.OrderService', 'type:demo.shipping.ShippingService']);
    expect(ids([{ methodsOf: SERVICE }]).every((id) => id.startsWith('method:demo.orders.domain.OrderService#'))).toBe(true);
    const reach = ids([{ reachable: { from: 'entry:OrderController.create', depth: 6 } }]);
    expect(reach).toEqual(expect.arrayContaining(['topic:orders.v1', 'entry:ShippingListener.onOrder', 'ext:db:sql']));
  });

  it('rejects unknown ids with a suggestion', async () => {
    const res = await compileView(spec({ ...FLOW, include: ['type:demo.orders.domain.OrderServise'] }), facts, { strict: true });
    expect(res.canvas).toBeUndefined();
    expect(res.errors[0]).toMatch(/unknown id type:demo\.orders\.domain\.OrderServise \(did you mean .*OrderService/);
  });

  it('compiles the same spec to byte-identical canvases', async () => {
    const a = await compileView(spec(FLOW), facts);
    const b = await compileView(spec(FLOW), new FactsIndex(await analyze(KAFKA)));
    expect(JSON.stringify(a.canvas)).toBe(JSON.stringify(b.canvas));
    const t = texts(a.canvas!).map((x) => x.split('\n')[0]);
    expect(t).toEqual(expect.arrayContaining(['📦 orders-service', 'OrderService · @Service', '## 📨 orders.v1']));
  });

  it('lifts edges of hidden methods to their classes', async () => {
    const res = await compileView(spec({ name: 'arch', title: 'Architecture', include: ['kind:type', 'kind:external'], exclude: ['role:model', 'role:config'], groupBy: 'lane' }), facts);
    expect(res.errors).toEqual([]);
    expect(res.canvas!.edges.length).toBeGreaterThan(0);
  });
});

describe('stable re-rendering', () => {
  it('keeps every existing node in place after a code change and reports the diff', async () => {
    const root = copyFixture();
    const out = path.join(root, 'code-view');
    const store = new ViewStore(out);
    const s = spec(FLOW);
    store.write(s);
    const first = await store.render(s, new FactsIndex(await analyze(root)), { strict: true });
    expect(first.errors).toEqual([]);
    const before = readCanvas(out, first.canvas!);

    const file = path.join(root, 'orders-service/src/main/java/demo/orders/domain/OrderService.java');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace('    Order saved = repository.save(order);', '    audit(order);\n    Order saved = repository.save(order);')
      .replace('  public Order find(Long id) {', '  private void audit(Order order) {\n    System.out.println(order);\n  }\n\n  public Order find(Long id) {'));

    const second = await store.render(s, new FactsIndex(await analyze(root)));
    expect(second.changes!.added).toEqual(['audit(order)']);
    expect(second.changes!.removed).toEqual([]);
    const after = readCanvas(out, second.canvas!);
    for (const n of before.nodes.filter((x) => x.type !== 'group')) {
      const m = after.nodes.find((x) => x.id === n.id)!;
      expect({ id: m.id, x: m.x, y: m.y, color: m.color }, n.type === 'text' ? n.text.split('\n')[0] : n.id).toEqual({ id: n.id, x: n.x, y: n.y, color: n.color });
    }
    // The new node does not overlap any other node.
    const added = after.nodes.find((x) => x.type === 'text' && x.text.startsWith('**audit('))!;
    for (const n of after.nodes.filter((x) => x.type !== 'group' && x !== added)) {
      const apart = added.x >= n.x + n.width || n.x >= added.x + added.width || added.y >= n.y + n.height || n.y >= added.y + added.height;
      expect(apart, `overlaps ${n.id}`).toBe(true);
    }
  });

  it('regenerating unchanged code reproduces every canvas exactly, including saved views', async () => {
    const out = tmpOut('stable');
    new ViewStore(out).write(spec(FLOW));
    const a = await generate(KAFKA, { out });
    const snap = Object.fromEntries(a.files.filter((f) => f.endsWith('.canvas')).map((f) => [f, fs.readFileSync(path.join(out, f), 'utf8')]));
    expect(Object.keys(snap)).toContain('views/order-to-shipping.canvas');
    await generate(KAFKA, { out });
    for (const [f, text] of Object.entries(snap)) expect(fs.readFileSync(path.join(out, f), 'utf8'), f).toBe(text);
  });

  it('applies the project theme to every canvas', async () => {
    const out = tmpOut('theme');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'theme.yaml'), "colors:\n  service: '#123456'\n");
    await generate(KAFKA, { out });
    const colors = readCanvas(out, 'components/orders-service.components.canvas').nodes.map((n) => n.color);
    expect(colors).toContain('#123456');
    expect(colors).not.toContain('#22c55e');
  });
});

describe('MCP server', () => {
  it('finds, creates and updates views through tools', async () => {
    const root = copyFixture();
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(root).connect(a);
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
    };

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['project_summary', 'search', 'trace', 'find_view', 'create_view', 'update_view', 'render']));
    expect((await call('project_summary')).data.modules).toEqual(['orders-service', 'shipping-service']);
    expect((await call('trace', { entry: 'entry:OrderController.create' })).data.steps[0]).toMatchObject({ seq: 1, from: expect.stringContaining('OrderController#create') });

    const bad = await call('create_view', { spec: { ...FLOW, include: ['type:nope.Missing'] } });
    expect(bad.error).toBe(true);
    const dry = await call('create_view', { spec: FLOW, dry_run: true });
    expect(dry.data.shown).toContain('# 🌐 POST /orders');
    const created = await call('create_view', { spec: FLOW });
    expect(created.error).toBe(false);
    expect(fs.existsSync(path.join(root, 'code-view/specs/order-to-shipping.view.yaml'))).toBe(true);
    expect((await call('create_view', { spec: FLOW })).error).toBe(true);

    expect((await call('find_view', { question: 'show me how orders reach shipping' })).data[0].name).toBe('order-to-shipping');
    const updated = await call('update_view', { name: 'order-to-shipping', patch: { exclude: ['kind:external'], annotations: { [SERVICE]: { emphasis: 'highlight' } } } });
    expect(updated.error).toBe(false);
    expect(updated.data.changes.removed).toEqual(['🗄 Database (postgresql)']);
    expect(updated.data.shown).toContain('[⭐ OrderService · @Service]');
    await client.close();
  });
});
