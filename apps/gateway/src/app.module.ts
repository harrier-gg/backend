import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { AgentHub } from './agents/agent-hub';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { DiscordController } from './auth/discord.controller';
import { Sessions } from './auth/session';
import { UsersController } from './auth/users.controller';
import { loadConfig } from './config';
import { ConsoleHub } from './console-hub';
import { AgentsController, SystemController } from './controllers';
import { NATS } from './nats';
import { AgentsNatsController, NodesController, ServersController, TemplatesController } from './servers.controllers';
import { SameOriginMiddleware } from './same-origin.middleware';
import { WsRouter } from './ws-router';
import { TransferHub } from './agents/transfer-hub';
import { BackupsController, FilesController } from './files.controller';
import { ContentController } from './content.controller';
import { ContractRef } from './openapi';

const config = loadConfig();

@Module({
  controllers: [AuthController, DiscordController, UsersController, SystemController, AgentsController, ServersController, TemplatesController, NodesController, AgentsNatsController, FilesController, BackupsController, ContentController],
  providers: [
    AgentHub,
    TransferHub,
    ConsoleHub,
    Sessions,
    { provide: APP_GUARD, useClass: AuthGuard },
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
