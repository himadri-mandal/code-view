export { analyze, generate, type GenerateOptions, type GenerateResult } from './generate.js';
export type { Canvas, CanvasEdge, CanvasNode } from './canvas/canvas.js';
export { buildCfg } from './analyze/cfg.js';
export { FactsIndex, type Fact, type FactEdge, type FactKind, type EdgeKind } from './facts/index.js';
export { ProjectSession } from './facts/session.js';
export { ViewSpecSchema, parseSpec, type ViewSpec, type ViewSpecInput, type Selector } from './spec/schema.js';
export { compileSpec, compileView } from './spec/compile.js';
export { ViewStore, mergePatch } from './spec/registry.js';
export { createServer, serveStdio } from './mcp/server.js';
