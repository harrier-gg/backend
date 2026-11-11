import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  Subjects,
  type AgentsRequestReply,
  type AgentsSendReply,
  type AgentsSendRequest,
  type MetricPoint,
  type NodeCreated,
  type NodeSummary,
  type Reply,
  type ServerStatus,
  type ServerSummary,
  type TemplateConfigField,
  type TemplateSummary,
  type GameVersion,
  type VersionList,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentHub } from './agents/agent-hub';
import { Allow } from './auth/auth.guard';
import { NATS } from './nats';

const STATUSES: ServerStatus[] = ['installing', 'starting', 'running', 'stopping', 'stopped', 'crashed'];

class LocalizedTextDto {
  @ApiProperty() en!: string;
  @ApiPropertyOptional() de?: string;
}

class TemplateConfigFieldDto implements TemplateConfigField {
  @ApiProperty() key!: string;
  @ApiProperty({ type: LocalizedTextDto }) label!: LocalizedTextDto;
  @ApiProperty({ enum: ['string', 'integer', 'version'], description: 'version: pick from GET /templates/versions' }) type!: 'string' | 'integer' | 'version';
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }] }) default!: string | number;
  @ApiPropertyOptional() min?: number;
  @ApiPropertyOptional() max?: number;
  @ApiPropertyOptional() pattern?: string;
}

class ConfigFileRefDto {
  @ApiProperty({ example: 'server.properties' }) path!: string;
}

class TemplateFileDto extends ConfigFileRefDto {
  @ApiPropertyOptional({ type: LocalizedTextDto }) description?: LocalizedTextDto;
}

class ConfigFileDto extends ConfigFileRefDto {
  @ApiProperty({ type: String, nullable: true, description: 'null while the file does not exist, e.g. before the first start' })
  content!: string | null;
}

class WriteConfigFileDto extends ConfigFileRefDto {
  @ApiProperty({ description: 'New content, at most 128 KiB' }) content!: string;
}

class GameVersionDto implements GameVersion {
  @ApiProperty({ example: '26.3' }) id!: string;
  @ApiProperty({ enum: ['release', 'snapshot'] }) type!: 'release' | 'snapshot';
}

class VersionListDto implements VersionList {
  @ApiProperty({ example: '26.3', description: 'The newest release; what "latest" starts' }) latest!: string;
  @ApiProperty({ type: [GameVersionDto], description: 'Newest first' }) versions!: GameVersionDto[];
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
  @ApiProperty({ type: [TemplateFileDto], description: 'Files owners and admins can edit' }) files!: TemplateFileDto[];
  @ApiProperty({ type: [TemplateConfigFieldDto] }) config!: TemplateConfigFieldDto[];
}

class NodeDto implements NodeSummary {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastSeenAt!: string | null;
  @ApiProperty({ description: 'Whether the agent is connected right now' }) online!: boolean;
}

class CreateNodeDto {
  @ApiProperty({ example: 'gaming-pc', description: '1–64 characters: letters, digits, ".", "_", "-"' }) name!: string;
}

class NodeCreatedDto implements NodeCreated {
  @ApiProperty({ type: NodeDto }) node!: NodeDto;
  @ApiProperty({ description: 'Agent token (HARRIER_AGENT_TOKEN). Shown only once.' }) token!: string;
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

class SettingsDto {
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] }, description: 'Changed settings; keys left out keep their value' })
  settings!: Record<string, string | number>;
}

class MetricPointDto implements MetricPoint {
  @ApiProperty({ format: 'date-time', description: 'Start of the bucket' }) at!: string;
  @ApiProperty({ description: 'Average CPU usage; 100 = one core' }) cpuPercent!: number;
  @ApiProperty({ description: 'Peak memory usage' }) memoryBytes!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Peak players online; null for games without a player query' })
  players!: number | null;
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

  /** Versions for a template's version field, from its version provider (ADR 0012). */
  @Get('versions')
  @ApiQuery({ name: 'template', example: 'minecraft-java/paper' })
  @ApiOkResponse({ type: VersionListDto })
  versions(@Query('template') template: string): Promise<VersionListDto> {
    return call(this.nats, Subjects.templatesVersions, { template });
  }
}

@ApiTags('nodes')
@Allow('manageServers')
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

  @Post()
  @HttpCode(200)
  @ApiBody({ type: CreateNodeDto })
  @ApiOkResponse({ type: NodeCreatedDto })
  async create(@Body() body: CreateNodeDto): Promise<NodeCreatedDto> {
    const created = await call<NodeCreated>(this.nats, Subjects.nodesCreate, { name: body?.name });
    return { ...created, node: { ...created.node, online: false } };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await call(this.nats, Subjects.nodesRemove, { id });
    this.agents.disconnect(id);
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
  @Allow('manageServers')
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

  @Get('servers/:id/metrics')
  @ApiQuery({ name: 'range', enum: ['1h', '24h', '7d'] })
  @ApiOkResponse({ type: [MetricPointDto] })
  metrics(@Param('id', ParseUUIDPipe) id: string, @Query('range') range: string): Promise<MetricPointDto[]> {
    return call(this.nats, Subjects.serversMetrics, { id, range });
  }

  @Post('servers/:id/start')
  @Allow('startStopServers')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  start(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStart, { id });
  }

  @Post('servers/:id/stop')
  @Allow('startStopServers')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  stop(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStop, { id });
  }

  /** Settings apply on the next start (a running server keeps its current ones). */
  @Put('servers/:id/settings')
  @Allow('manageServers')
  @ApiBody({ type: SettingsDto })
  @ApiOkResponse({ type: ServerDto })
  updateSettings(@Param('id', ParseUUIDPipe) id: string, @Body() body: SettingsDto): Promise<ServerDto> {
    return call(this.nats, Subjects.serversUpdateSettings, { id, settings: body?.settings });
  }

  /** A config file the template lists (ADR 0011). */
  @Get('servers/:id/files')
  @Allow('manageServers')
  @ApiQuery({ name: 'path', example: 'server.properties' })
  @ApiOkResponse({ type: ConfigFileDto })
  readFile(@Param('id', ParseUUIDPipe) id: string, @Query('path') path: string): Promise<ConfigFileDto> {
    return call(this.nats, Subjects.serversReadFile, { id, path });
  }

  /** Replaces a config file the template lists. The server reads it on its next start. */
  @Put('servers/:id/files')
  @Allow('manageServers')
  @ApiBody({ type: WriteConfigFileDto })
  @ApiOkResponse({ type: ConfigFileDto })
  writeFile(@Param('id', ParseUUIDPipe) id: string, @Body() body: WriteConfigFileDto): Promise<ConfigFileDto> {
    return call(this.nats, Subjects.serversWriteFile, { id, path: body?.path, content: body?.content });
  }

  @Post('servers/:id/command')
  @Allow('sendCommands')
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
  @MessagePattern(Subjects.agentsRequest)
  request(@Payload() payload: AgentsSendRequest): Promise<AgentsRequestReply> {
    return this.agents.request(payload.nodeId, payload.message as PanelMessage & { requestId: string });
  }

  @MessagePattern(Subjects.agentsSend)
  send(@Payload() payload: AgentsSendRequest): AgentsSendReply {
    return { delivered: this.agents.send(payload.nodeId, payload.message as PanelMessage) };
  }
}
