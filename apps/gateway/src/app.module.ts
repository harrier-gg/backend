import { Module } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { AgentHub } from './agents/agent-hub';
import { loadConfig } from './config';
import { AgentsController, SystemController } from './controllers';
import { NATS } from './nats';
import { ContractRef } from './openapi';

const config = loadConfig();

@Module({
  controllers: [SystemController, AgentsController],
  providers: [
    AgentHub,
    ContractRef,
    {
      provide: NATS,
      useFactory: () => ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } }),
    },
  ],
})
export class AppModule {}

export { config };
