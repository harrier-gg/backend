import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { SwaggerModule } from '@nestjs/swagger';
import { AGENT_WS_PATH } from './agents/agent-hub';
import { AppModule, config } from './app.module';
import { buildOpenApi, ContractRef } from './openapi';
import { ProblemDetailsFilter } from './problem-details.filter';
import { VERSION } from './version';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Config files may be up to 128 KiB (ADR 0011); Express allows 100 KB by default.
  app.useBodyParser('json', { limit: '300kb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  // The gateway also answers NATS requests (agents.send) from the servers service.
  app.connectMicroservice<MicroserviceOptions>({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } });
  await app.startAllMicroservices();

  const { document, contract } = buildOpenApi(app);
  app.get(ContractRef).value = contract;
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(config.HARRIER_PORT, config.HARRIER_HOST);
  const log = new Logger('Gateway');
  log.log(`Harrier Gateway v${VERSION} on http://${config.HARRIER_HOST}:${config.HARRIER_PORT} (contract ${contract})`);
  log.log(`API docs: http://${config.HARRIER_HOST}:${config.HARRIER_PORT}/api/docs · agents: ws://${config.HARRIER_HOST}:${config.HARRIER_PORT}${AGENT_WS_PATH}`);
}

void bootstrap();
