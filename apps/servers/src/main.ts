import 'reflect-metadata';
import { Controller, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'node:path';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { config } from './config';
import { createDb } from './db';
import { DB, NodesController } from './nodes.controller';
import { NATS, ServersController, TEMPLATES, VERSIONS } from './servers.controller';
import { BackupsController } from './backups.controller';
import { CONTENT, ContentController } from './content.controller';
import { providers } from './content';
import { VersionProviders } from './versions';
import { TemplateCatalog } from './templates';
import { VERSION } from './version';

@Controller()
class HealthController {
  @MessagePattern(Subjects.serversHealth)
  health(): ServiceHealth {
    return { service: 'servers', status: 'ok', version: VERSION };
  }
}

@Module({
  controllers: [HealthController, NodesController, ServersController, BackupsController, ContentController],
  providers: [
    { provide: DB, useFactory: createDb },
    { provide: NATS, useFactory: () => ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } }) },
    // Official templates ship with the backend for now; they move to the templates repository later.
    { provide: VERSIONS, useFactory: () => new VersionProviders() },
    { provide: CONTENT, useFactory: () => providers() },
    { provide: TEMPLATES, useFactory: () => TemplateCatalog.fromDirectory(config.HARRIER_TEMPLATES_DIR ?? join(__dirname, '../../../templates')) },
  ],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.NATS,
    options: { servers: [config.HARRIER_NATS_URL], queue: 'servers' },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger('Servers').log(`Harrier Servers v${VERSION} listening on NATS ${config.HARRIER_NATS_URL}`);
}

void bootstrap();
