import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AGENT_WS_PATH } from './agents/agent-hub';
import { AppModule, config } from './app.module';
import { buildOpenApi, ContractRef } from './openapi';
import { ProblemDetailsFilter } from './problem-details.filter';
import { VERSION } from './version';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  const { document, contract } = buildOpenApi(app);
  app.get(ContractRef).value = contract;
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(config.HARRIER_PORT);
  const log = new Logger('Gateway');
  log.log(`Harrier Gateway v${VERSION} auf http://localhost:${config.HARRIER_PORT} (Contract ${contract})`);
  log.log(`API-Doku: http://localhost:${config.HARRIER_PORT}/api/docs · Agents: ws://localhost:${config.HARRIER_PORT}${AGENT_WS_PATH}`);
}

void bootstrap();
