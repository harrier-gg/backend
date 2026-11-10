import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type ServiceHealth } from '@harrier-gg/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentHub } from './agents/agent-hub';
import { ContractRef } from './openapi';
import { VERSION } from './version';

export const NATS = Symbol('NATS');

class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] }) status!: 'ok' | 'degraded';
  @ApiProperty() version!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', enum: ['up', 'down'] }, example: { servers: 'up' } })
  services!: Record<string, 'up' | 'down'>;
}

class MetaDto {
  @ApiProperty({ example: '0.1.0' }) version!: string;
  @ApiProperty({ description: 'Hash der API-Form (paths + components). Das Web vergleicht ihn mit seinem generierten Client.' })
  contract!: string;
}

class AgentDto {
  @ApiProperty() id!: string;
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

  @Get('health')
  @ApiOkResponse({ type: HealthDto })
  async health(): Promise<HealthDto> {
    const servers = await firstValueFrom(
      this.nats.send<ServiceHealth>(Subjects.serversHealth, {}).pipe(timeout(1500)),
    ).then(
      () => 'up' as const,
      () => 'down' as const,
    );
    return { status: servers === 'up' ? 'ok' : 'degraded', version: VERSION, services: { servers } };
  }

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
