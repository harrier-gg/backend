import { Injectable, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { VERSION } from './version';

/** Hält den Contract-Hash, damit /meta ihn ausliefern kann. */
@Injectable()
export class ContractRef {
  value = 'unknown';
}

/**
 * Contract = Hash über die Form der API (paths + components), ohne Versionsnummer.
 * Das Web berechnet denselben Hash aus seiner openapi.json (vite.config.ts). Stimmen sie nicht überein,
 * passt das Frontend nicht zum Backend.
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
    // SystemController.health → systemHealth (wird zum Funktionsnamen im generierten Web-Client)
    operationIdFactory: (controller, method) =>
      controller.replace(/Controller$/, '').replace(/^./, (c) => c.toLowerCase()) + method[0].toUpperCase() + method.slice(1),
  });
  return { document, contract: contractHash(document) };
}
