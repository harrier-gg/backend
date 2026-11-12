import 'reflect-metadata';
import { Controller, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, MessagePattern, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { config } from './config';
import { createDb, type Db } from './db';
import { DB, IdentityController, SetupToken } from './identity.controller';
import { NATS, SETTINGS, Settings } from './settings';
import { SettingsController } from './settings.controller';
import { InvitesController } from './invites.controller';
import { DiscordController } from './discord.controller';
import { VERSION } from './version';

@Controller()
class HealthController {
  @MessagePattern(Subjects.identityHealth)
  health(): ServiceHealth {
    return { service: 'identity', status: 'ok', version: VERSION };
  }
}

@Module({
  controllers: [HealthController, IdentityController, InvitesController, DiscordController, SettingsController],
  providers: [
    { provide: DB, useFactory: createDb },
    SetupToken,
    { provide: SETTINGS, useFactory: (db: Db) => new Settings(db, config.HARRIER_APP_KEY), inject: [DB] },
    { provide: NATS, useFactory: () => ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } }) },
  ],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.NATS,
    options: { servers: [config.HARRIER_NATS_URL], queue: 'identity' },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger('Identity').log(`Harrier Identity v${VERSION} listening on NATS ${config.HARRIER_NATS_URL}`);
}

void bootstrap();
