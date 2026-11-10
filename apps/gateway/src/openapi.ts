import { Injectable, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { VERSION } from './version';

/** Holds the contract hash so /meta can serve it. */
@Injectable()
export class ContractRef {
  value = 'unknown';
}

/**
 * Contract = hash of the API shape (paths + components), without the version number.
 * The web app computes the same hash from its openapi.json (vite.config.ts). If they differ,
 * the frontend does not match the backend.
 */
export function contractHash(doc: Pick<OpenAPIObject, 'paths' | 'components'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ paths: doc.paths, components: doc.components }))
    .digest('hex')
    .slice(0, 16);
}

export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Harrier API')
    .setVersion(VERSION)
    .addServer('/api/v1')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    ignoreGlobalPrefix: true,
    // SystemController.health → systemHealth (becomes the function name in the generated web client)
    operationIdFactory: (controller, method) =>
      controller.replace(/Controller$/, '').replace(/^./, (c) => c.toLowerCase()) + method[0].toUpperCase() + method.slice(1),
  });
  return { document, contract: contractHash(document) };
}
