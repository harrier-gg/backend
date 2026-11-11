import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  Subjects,
  type AgentsSendReply,
  type AgentsSendRequest,
  type NodeSummary,
  type Reply,
  type ServerStatus,
  type ServerSummary,
  type TemplateConfigField,
  type TemplateSummary,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentHub } from './agents/agent-hub';
import { NATS } from './nats';

const STATUSES: ServerStatus[] = ['installing', 'starting', 'running', 'stopping', 'stopped', 'crashed'];

class LocalizedTextDto {
  @ApiProperty() en!: string;
  @ApiPropertyOptional() de?: string;
}

class TemplateConfigFieldDto implements TemplateConfigField {
  @ApiProperty() key!: string;
  @ApiProperty({ type: LocalizedTextDto }) label!: LocalizedTextDto;
  @ApiProperty({ enum: ['string', 'integer'] }) type!: 'string' | 'integer';
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }] }) default!: string | number;
  @ApiPropertyOptional() min?: number;
  @ApiPropertyOptional() max?: number;
  @ApiPropertyOptional() pattern?: string;
}

class NamedDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

class VariantDto extends NamedDto {
  @ApiPropertyOptional({ type: LocalizedTextDto }) description?: LocalizedTextDto;
}

class TemplateDto implements TemplateSummary {
  @ApiProperty({ example: 'minecraft-java/paper' }) id!: string;
  @ApiProperty({ type: NamedDto }) game!: NamedDto;
  @ApiProperty({ type: VariantDto }) variant!: VariantDto;
  @ApiProperty({ type: [TemplateConfigFieldDto] }) config!: TemplateConfigFieldDto[];
}

class NodeDto implements NodeSummary {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastSeenAt!: string | null;
  @ApiProperty({ description: 'Whether the agent is connected right now' }) online!: boolean;
}

class ServerDto implements ServerSummary {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() nodeId!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
  settings!: Record<string, string | number>;
  @ApiProperty({ description: 'Port players connect to on the node' }) hostPort!: number;
  @ApiProperty({ enum: STATUSES }) status!: ServerStatus;
  @ApiProperty({ type: String, nullable: true }) statusMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class CreateServerDto {
  @ApiProperty() nodeId!: string;
  @ApiProperty({ example: 'Survival' }) name!: string;
  @ApiProperty({ example: 'minecraft-java/paper' }) templateId!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
  settings?: Record<string, string | number>;
}

class CommandDto {
  @ApiProperty({ example: 'say Hello' }) command!: string;
}

/** Calls the servers service and turns `{ error }` replies into problem details (RFC 9457). */
async function call<T>(nats: ClientProxy, subject: string, payload: unknown): Promise<T> {
  const reply = await firstValueFrom(nats.send<Reply<T>>(subject, payload).pipe(timeout(5000))).catch(() => {
    throw new HttpException('The servers service is unavailable', 503);
  });
  if ('error' in reply) throw new HttpException(reply.error.detail, reply.error.status);
  return reply.data;
}

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get()
  @ApiOkResponse({ type: [TemplateDto] })
  list(): Promise<TemplateDto[]> {
    return call(this.nats, Subjects.templatesList, {});
  }
}

@ApiTags('nodes')
@Controller('nodes')
export class NodesController {
  constructor(
    @Inject(NATS) private readonly nats: ClientProxy,
    private readonly agents: AgentHub,
  ) {}

  @Get()
  @ApiOkResponse({ type: [NodeDto] })
  async list(): Promise<NodeDto[]> {
    const nodes = await call<NodeSummary[]>(this.nats, Subjects.nodesList, {});
    return nodes.map((n) => ({ ...n, online: this.agents.isOnline(n.id) }));
  }
}

@ApiTags('servers')
@Controller()
export class ServersController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get('servers')
  @ApiOkResponse({ type: [ServerDto] })
  list(): Promise<ServerDto[]> {
    return call(this.nats, Subjects.serversList, {});
  }

  @Post('servers')
  @ApiBody({ type: CreateServerDto })
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  create(@Body() body: CreateServerDto): Promise<ServerDto> {
    return call(this.nats, Subjects.serversCreate, body);
  }

  @Get('servers/:id')
  @ApiOkResponse({ type: ServerDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversGet, { id });
  }

  @Post('servers/:id/start')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  start(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStart, { id });
  }

  @Post('servers/:id/stop')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  stop(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStop, { id });
  }

  @Post('servers/:id/command')
  @ApiBody({ type: CommandDto })
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  command(@Param('id', ParseUUIDPipe) id: string, @Body() body: CommandDto): Promise<ServerDto> {
    return call(this.nats, Subjects.serversCommand, { id, command: body?.command });
  }
}

/** NATS side: the servers service asks the gateway to deliver messages to agents. */
@Controller()
export class AgentsNatsController {
  constructor(private readonly agents: AgentHub) {}

  // ponytail: one gateway instance; with several, route by node (e.g. subject per node)
  @MessagePattern(Subjects.agentsSend)
  send(@Payload() payload: AgentsSendRequest): AgentsSendReply {
    return { delivered: this.agents.send(payload.nodeId, payload.message as PanelMessage) };
  }
}
