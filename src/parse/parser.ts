import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
let parser: Parser | undefined;

export async function getParser(): Promise<Parser> {
  if (parser) return parser;
  await Parser.init();
  const java = await Language.load(require.resolve('tree-sitter-java/tree-sitter-java.wasm'));
  parser = new Parser();
  parser.setLanguage(java);
  return parser;
}
