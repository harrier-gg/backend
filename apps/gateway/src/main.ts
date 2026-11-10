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

  await app.listen(config.HARRIER_PORT, config.HARRIER_HOST);
  const log = new Logger('Gateway');
  log.log(`Harrier Gateway v${VERSION} on http://${config.HARRIER_HOST}:${config.HARRIER_PORT} (contract ${contract})`);
  log.log(`API docs: http://${config.HARRIER_HOST}:${config.HARRIER_PORT}/api/docs · agents: ws://${config.HARRIER_HOST}:${config.HARRIER_PORT}${AGENT_WS_PATH}`);
}

void bootstrap();
