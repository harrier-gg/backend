import 'reflect-metadata';
import { Controller, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { z } from 'zod';
import { VERSION } from './version';

const config = z
  .object({ HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222') })
  .parse(process.env);

@Controller()
class HealthController {
  @MessagePattern(Subjects.serversHealth)
  health(): ServiceHealth {
    return { service: 'servers', status: 'ok', version: VERSION };
  }
}

@Module({ controllers: [HealthController] })
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
