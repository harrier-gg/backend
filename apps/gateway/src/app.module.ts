import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { AgentHub } from './agents/agent-hub';
import { loadConfig } from './config';
import { ConsoleHub } from './console-hub';
import { AgentsController, SystemController } from './controllers';
import { NATS } from './nats';
import { AgentsNatsController, NodesController, ServersController, TemplatesController } from './servers.controllers';
import { SameOriginMiddleware } from './same-origin.middleware';
import { WsRouter } from './ws-router';
import { ContractRef } from './openapi';

const config = loadConfig();

@Module({
  controllers: [SystemController, AgentsController, ServersController, TemplatesController, NodesController, AgentsNatsController],
  providers: [
    AgentHub,
    ConsoleHub,
    WsRouter,
    ContractRef,
    {
      provide: NATS,
      useFactory: () => ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SameOriginMiddleware).forRoutes('*path');
  }
}

export { config };
