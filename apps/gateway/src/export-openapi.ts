import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildOpenApi } from './openapi';

// Schreibt openapi.json ohne den Server zu starten. Aufruf: `just api`.
async function main() {
  const out = process.argv[2] ?? 'openapi.json';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const { document, contract } = buildOpenApi(app);
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`${out} geschrieben (Contract ${contract})`);
  await app.close();
}

void main();
