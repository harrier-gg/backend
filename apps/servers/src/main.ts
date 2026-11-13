import 'reflect-metadata';
import { Controller, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { config } from './config';
import { createDb, type Db } from './db';
import { DB, NodesController } from './nodes.controller';
import { NATS, ServersController, TEMPLATES, VERSIONS } from './servers.controller';
import { BackupsController } from './backups.controller';
import { CONTENT, ContentController } from './content.controller';
import { ShareController } from './share.controller';
import { providers } from './content';
import { VersionProviders } from './versions';
import { loadTemplates } from './template-source';
import { VERSION } from './version';

@Controller()
class HealthController {
  @MessagePattern(Subjects.serversHealth)
  health(): ServiceHealth {
    return { service: 'servers', status: 'ok', version: VERSION };
  }
}

@Module({
  controllers: [HealthController, NodesController, ServersController, BackupsController, ContentController, ShareController],
  providers: [
    { provide: DB, useFactory: createDb },
    { provide: NATS, useFactory: () => ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } }) },
    { provide: VERSIONS, useFactory: () => new VersionProviders() },
    { provide: CONTENT, useFactory: () => providers() },
    { provide: TEMPLATES, inject: [DB], useFactory: (db: Db) => loadTemplates(db, config.HARRIER_TEMPLATES_URL) },
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
