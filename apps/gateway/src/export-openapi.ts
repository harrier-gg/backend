import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildOpenApi } from './openapi';

// Writes openapi.json without starting the server. Usage: `just api`.
async function main() {
  const out = process.argv[2] ?? 'openapi.json';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const { document, contract } = buildOpenApi(app);
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`${out} written (contract ${contract})`);
  await app.close();
}

void main();
