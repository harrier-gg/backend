import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentHub } from './agents/agent-hub';
import { Public } from './auth/auth.guard';
import { ContractRef } from './openapi';
import { NATS } from './nats';
import { VERSION } from './version';

class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] }) status!: 'ok' | 'degraded';
  @ApiProperty() version!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', enum: ['up', 'down'] }, example: { servers: 'up' } })
  services!: Record<string, 'up' | 'down'>;
}

class MetaDto {
  @ApiProperty({ example: '0.1.0' }) version!: string;
  @ApiProperty({ description: 'Hash of the API shape (paths + components). The web app compares it with its generated client.' })
  contract!: string;
}

class AgentDto {
  @ApiProperty({ description: 'Node ID (from the agent token)' }) id!: string;
  @ApiProperty({ description: 'Node name given at registration' }) name!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty() os!: string;
  @ApiProperty() arch!: string;
  @ApiProperty() agentVersion!: string;
  @ApiProperty() protocol!: number;
  @ApiProperty({ format: 'date-time' }) connectedAt!: string;
}

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(
    @Inject(NATS) private readonly nats: ClientProxy,
    private readonly contract: ContractRef,
  ) {}

  @Public()
  @Get('health')
  @ApiOkResponse({ type: HealthDto })
  async health(): Promise<HealthDto> {
    const ping = (subject: string) =>
      firstValueFrom(this.nats.send<ServiceHealth>(subject, {}).pipe(timeout(1500))).then(
        () => 'up' as const,
        () => 'down' as const,
      );
    const [servers, identity] = await Promise.all([ping(Subjects.serversHealth), ping(Subjects.identityHealth)]);
    const services = { servers, identity };
    return { status: Object.values(services).every((s) => s === 'up') ? 'ok' : 'degraded', version: VERSION, services };
  }

  @Public()
  @Get('meta')
  @ApiOkResponse({ type: MetaDto })
  meta(): MetaDto {
    return { version: VERSION, contract: this.contract.value };
  }
}

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly hub: AgentHub) {}

  @Get()
  @ApiOkResponse({ type: [AgentDto] })
  list(): AgentDto[] {
    return this.hub.list();
  }
}
