// Erzeugt src/index.ts, das alle generierten Typen re-exportiert.
import { readdirSync, writeFileSync } from 'node:fs';
const dir = new URL('../src/generated/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
const lines = files.map((f) => `export type * from './generated/${f.replace(/\.ts$/, '')}';`);
writeFileSync(new URL('../src/index.ts', import.meta.url), `// Generiert von scripts/index.mjs\n${lines.join('\n')}\n`);
