import { writeFileSync } from 'node:fs';
import { templateFileSchema } from './templates';

// Writes the JSON Schema of template files (the templates repo validates against it). Usage: `just schema`.
const out = process.argv[2] ?? 'template.schema.json';
writeFileSync(out, `${JSON.stringify(templateFileSchema(), null, 2)}\n`);
console.log(`${out} written`);
