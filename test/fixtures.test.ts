import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCanvas } from '../src/canvas/canvas.js';
import { analyze, generate } from '../src/generate.js';
import { edgeList, FIXTURES, hasFixture, readCanvas, texts, tmpOut } from './helpers.js';

function allCanvasesValid(dir: string, files: string[]) {
  for (const f of files.filter((x) => x.endsWith('.canvas'))) {
    expect(validateCanvas(readCanvas(dir, f)), f).toEqual([]);
  }
  // Every wikilink must point at a file that was generated.
  const linked = files
    .filter((f) => f.endsWith('.canvas'))
    .flatMap((f) => texts(readCanvas(dir, f)).flatMap((t) => [...t.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1])));
  for (const l of new Set(linked)) expect(fs.existsSync(path.join(dir, l)), `dangling link ${l}`).toBe(true);
}

describe('kafka-mini (multi-module Spring Kafka)', async () => {
  const out = tmpOut('kafka');
  const res = await generate(path.join(FIXTURES, 'kafka-mini'), { out });

  it('detects both modules and writes the expected canvases', () => {
    expect(res.files).toEqual(expect.arrayContaining([
      'index.canvas',
      'events.canvas',
      'components/orders-service.components.canvas',
      'components/shipping-service.components.canvas',
      'flows/OrderController.create.flow.canvas',
      'flows/ShippingListener.onOrder.flow.canvas',
      'methods/OrderService.place.cfg.canvas',
      'README.md',
    ]));
    allCanvasesValid(out, res.files);
  });

  it('resolves topics from @Value placeholders, constants, StreamBridge bindings and @RetryableTopic', async () => {
    const { kafka } = await analyze(path.join(FIXTURES, 'kafka-mini'));
    const topics = Object.fromEntries([...kafka.topics.values()].map((t) => [t.name, t]));
    expect(Object.keys(topics).sort()).toEqual(['audit-events', 'orders.v1', 'orders.v1-dlt', 'orders.v1-retry', 'shipments']);
    expect(topics['orders.v1']).toMatchObject({ partitions: '6', replicas: '3' });
    expect([...topics['orders.v1'].groups]).toEqual(['shipping']);
    expect([...topics['orders.v1'].payloads]).toEqual(['OrderMessage']);
    expect(topics['shipments']).toMatchObject({ partitions: '3', replicas: '1' });
    expect(topics['orders.v1-dlt']).toMatchObject({ role: 'dlt', parent: 'orders.v1' });
    expect(kafka.producers.map((p) => `${p.method.owner.name}.${p.method.name} -> ${p.topic}`).sort()).toEqual([
      'OrderPublisher.publish -> audit-events',
      'OrderPublisher.publish -> orders.v1',
      'ShippingListener.onOrder -> shipments',
    ]);
  });

  it('event map links producers → topics → consumers', () => {
    const e = edgeList(readCanvas(out, 'events.canvas'));
    expect(e).toEqual(expect.arrayContaining([
      '### OrderPublisher.publish() -> ## 📨 orders.v1 | KafkaTemplate.send',
      '## 📨 orders.v1 -> ### ShippingListener.onOrder() | @KafkaListener',
      '## 📨 orders.v1 -> ## ☠️ orders.v1-dlt | dead letter',
      '## ☠️ orders.v1-dlt -> ### ShippingListener.dead() | @DltHandler',
    ]));
  });

  it('call flow crosses into the database, Kafka (async hop) and Spring events', () => {
    const c = readCanvas(out, 'flows/OrderController.create.flow.canvas');
    expect(edgeList(c)).toEqual([
      '# 🌐 POST /orders -> **create(request)** | ',
      '**create(request)** -> **place(customer, items)** | 1',
      '**place(customer, items)** -> **validate(item)** | 2 [loop]',
      '**place(customer, items)** -> ### 🗄 Database (postgresql) | 3 OrderRepository.save()',
      '**place(customer, items)** -> **publish(order)** | 4',
      '**publish(order)** -> ### 📨 orders.v1 | 5 send',
      '**publish(order)** -> ### 📨 audit-events | 6 send [catch RuntimeException]',
      '**place(customer, items)** -> ### 📣 OrderPlaced | 7 publish',
    ]);
    const topic = texts(c).find((t) => t.startsWith('### 📨 orders.v1'))!;
    expect(topic).toContain('[[flows/ShippingListener.onOrder.flow.canvas|ShippingListener.onOrder]]');
  });

  it('classifies components into lanes', () => {
    const t = texts(readCanvas(out, 'components/orders-service.components.canvas'));
    const lane = (title: string) => t.find((x) => x.startsWith(title));
    expect(lane('Inbound')).toBeTruthy();
    expect(t.some((x) => x.startsWith('### OrderPublisher\n`@Component`'))).toBe(true);
    expect(t.some((x) => x.startsWith('### OrderRepository\n`Repository`'))).toBe(true);
    expect(t.some((x) => x.startsWith('### Topics\n`constants`'))).toBe(true);
  });
});

describe.skipIf(!hasFixture('spring-petclinic'))('spring-petclinic', async () => {
  const out = tmpOut('petclinic');
  const root = path.join(FIXTURES, 'spring-petclinic');
  const res = hasFixture('spring-petclinic') ? await generate(root, { out }) : undefined;

  it('writes valid, fully linked canvases', () => {
    allCanvasesValid(out, res!.files);
  });

  it('puts controllers inbound, repositories outbound and entities in the model lane', async () => {
    const { spring } = await analyze(root);
    const lane = (name: string) => [...spring.classes.values()].find((c) => c.type.name === name)?.lane;
    for (const c of ['OwnerController', 'PetController', 'VisitController', 'VetController']) expect(lane(c), c).toBe('inbound');
    for (const c of ['OwnerRepository', 'VetRepository', 'PetTypeRepository']) expect(lane(c), c).toBe('outbound');
    for (const c of ['Owner', 'Pet', 'Vet', 'Visit', 'BaseEntity']) expect(lane(c), c).toBe('model');
  });

  it('creates a flow per request mapping', async () => {
    const { spring } = await analyze(root);
    const http = spring.entries.filter((e) => e.kind === 'http').map((e) => e.trigger);
    expect(http).toEqual(expect.arrayContaining(['GET /owners/new', 'POST /owners/new', 'GET /owners', 'GET /owners/{ownerId}', 'POST /owners/{ownerId}/pets/new', 'GET /vets.html']));
    for (const e of spring.entries) expect(res!.files).toContain(`flows/${e.id}.flow.canvas`);
  });

  it('flowchart of processFindForm has all its decisions', () => {
    const t = texts(readCanvas(out, 'methods/OwnerController.processFindForm.cfg.canvas'));
    expect(t.filter((x) => x.startsWith('◆'))).toEqual([
      '◆ **if (lastName == null)**',
      '◆ **if (page < 1 || page > Math.max(ownersResults.getTotalPages(), 1))**',
      '◆ **if (!lastName.isEmpty())**',
      '◆ **if (ownersResults.isEmpty())**',
      '◆ **if (ownersResults.getTotalElements() == 1)**',
    ]);
  });
});

describe.skipIf(!hasFixture('spring-petclinic-ai'))('spring-petclinic-ai (Spring AI)', async () => {
  const out = tmpOut('petclinic-ai');
  const root = path.join(FIXTURES, 'spring-petclinic-ai');
  const res = hasFixture('spring-petclinic-ai') ? await generate(root, { out }) : undefined;

  it('writes valid, fully linked canvases', () => {
    allCanvasesValid(out, res!.files);
  });

  it('shows the LLM, vector store and tool entry points on the overview', () => {
    const t = texts(readCanvas(out, 'index.canvas'));
    expect(t.some((x) => x.startsWith('## 🧠 LLM') && x.includes('openai: gpt-4o'))).toBe(true);
    expect(t.some((x) => x.startsWith('## 🧭 Vector store') && x.includes('SimpleVectorStore'))).toBe(true);
    expect(edgeList(readCanvas(out, 'index.canvas'))).toContain('## 🧠 LLM -> ### Inbound | tool calls');
  });

  it('chat flow calls the LLM which may call the @Tool methods', async () => {
    const { spring } = await analyze(root);
    expect(spring.entries.filter((e) => e.kind === 'llm-tool').map((e) => e.method.name).sort()).toEqual(['addOwnerToPetclinic', 'addPetToOwner', 'listOwners', 'listVets']);
    const c = readCanvas(out, 'flows/PetclinicChatClient.exchange.flow.canvas');
    expect(edgeList(c)).toEqual(expect.arrayContaining([
      '**exchange(query)** -> ### 🧠 LLM | 1 prompt().user().call()',
      '### 🧠 LLM -> ### 🤖 Tools the LLM may call | function calling',
    ]));
  });
});
