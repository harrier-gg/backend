import 'reflect-metadata';
import { Controller, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { config } from './config';
import { createDb } from './db';
import { DB, NodesController } from './nodes.controller';
import { VERSION } from './version';

@Controller()
class HealthController {
  @MessagePattern(Subjects.serversHealth)
  health(): ServiceHealth {
    return { service: 'servers', status: 'ok', version: VERSION };
  }
}

@Module({
  controllers: [HealthController, NodesController],
  providers: [{ provide: DB, useFactory: createDb }],
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
