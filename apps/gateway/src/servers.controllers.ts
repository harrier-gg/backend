import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  can,
  Subjects,
  type ServerPort,
  type AgentsRequestReply,
  type AgentsSendReply,
  type AgentsSendRequest,
  type MetricPoint,
  type NodeCreated,
  type NodeSummary,
  type Reply,
  type ServerStatus,
  type ServerSummary,
  type SettingValue,
  type TemplateConfigField,
  type TemplateSummary,
  type GameVersion,
  type VersionList,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { ContentProjectDto } from './content.controller';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentHub } from './agents/agent-hub';
import { Allow, type AuthedRequest } from './auth/auth.guard';
import { NATS } from './nats';

const SETTING_VALUE = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }];
const STATUSES: ServerStatus[] = ['installing', 'starting', 'running', 'stopping', 'stopped', 'crashed', 'sleeping'];

/** Secret settings are shown only to users who may manage servers (ADR 0022). */
const secrets = (req: AuthedRequest) => can(req.user.role, 'manageServers');

class LocalizedTextDto {
  @ApiProperty() en!: string;
  @ApiPropertyOptional() de?: string;
}

class TemplateConfigFieldDto implements TemplateConfigField {
  @ApiProperty() key!: string;
  @ApiProperty({ type: LocalizedTextDto }) label!: LocalizedTextDto;
  @ApiProperty({
    enum: ['string', 'integer', 'version', 'modpack', 'boolean', 'secret'],
    description: 'version: pick from GET /templates/versions; modpack: a Modrinth modpack, its name or link; secret: text not shown in clear',
  })
  type!: TemplateConfigField['type'];
  @ApiProperty({ oneOf: SETTING_VALUE }) default!: SettingValue;
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

class ContentKindDto {
  @ApiProperty({ example: 'mod' }) kind!: string;
  @ApiProperty({ type: LocalizedTextDto }) label!: LocalizedTextDto;
  @ApiProperty({ example: 'mods' }) path!: string;
  @ApiProperty({ type: [String], example: ['modrinth'], description: 'Providers to search' }) sources!: string[];
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
  @ApiProperty({ type: [ContentKindDto], description: 'Content that can be installed (ADR 0017)' }) content!: ContentKindDto[];
  @ApiProperty({ type: String, nullable: true, enum: ['mrpack'], description: 'Pack format for sharing player content (ADR 0018)' }) share!: 'mrpack' | null;
  @ApiProperty({ type: [TemplateConfigFieldDto] }) config!: TemplateConfigFieldDto[];
  @ApiProperty({ enum: ['image', 'script'], description: '`script`: an install script runs before the first start and on reinstall (ADR 0022)' })
  install!: 'image' | 'script';
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

class ServerPortDto implements ServerPort {
  @ApiProperty({ example: 'game' }) name!: string;
  @ApiProperty({ example: 2456 }) port!: number;
  @ApiProperty({ enum: ['tcp', 'udp'] }) protocol!: 'tcp' | 'udp';
}

class ServerDto implements ServerSummary {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() nodeId!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: SETTING_VALUE } })
  settings!: Record<string, SettingValue>;
  @ApiProperty({ description: 'Port players connect to on the node' }) hostPort!: number;
  @ApiProperty({ type: [ServerPortDto], description: 'All ports of the server on the node; the first is hostPort' }) ports!: ServerPortDto[];
  @ApiProperty({ enum: STATUSES }) status!: ServerStatus;
  @ApiProperty({ type: String, nullable: true }) statusMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class CreateServerDto {
  @ApiProperty() nodeId!: string;
  @ApiProperty({ example: 'Survival' }) name!: string;
  @ApiProperty({ example: 'minecraft-java/paper' }) templateId!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { oneOf: SETTING_VALUE } })
  settings?: Record<string, SettingValue>;
}

class SettingsDto {
  @ApiProperty({ type: 'object', additionalProperties: { oneOf: SETTING_VALUE }, description: 'Changed settings; keys left out keep their value' })
  settings!: Record<string, SettingValue>;
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
export const AGENT_MS = 20_000;

/** `ms`: requests that reach an agent wait longer (the servers service gives it 15 s). */
export async function call<T>(nats: ClientProxy, subject: string, payload: unknown, ms = 5000): Promise<T> {
  const reply = await firstValueFrom(nats.send<Reply<T>>(subject, payload).pipe(timeout(ms))).catch(() => {
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

  /** Modrinth modpacks for a template's modpack field (ADR 0020), for the given game version. */
  @Get('modpacks')
  @ApiQuery({ name: 'template', example: 'minecraft-java/modrinth-modpack' })
  @ApiQuery({ name: 'version', required: false, description: 'Game version; empty or LATEST: any' })
  @ApiQuery({ name: 'query', required: false })
  @ApiOkResponse({ type: [ContentProjectDto] })
  modpacks(@Query('template') template: string, @Query('version') version = '', @Query('query') query = ''): Promise<ContentProjectDto[]> {
    return call(this.nats, Subjects.templatesModpacks, { template, version, query }, 20_000);
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
  @ApiQuery({ name: 'force', required: false, type: Boolean, description: 'Also remove the servers of an offline node from the panel. Their files stay on the machine.' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('force') force?: string): Promise<void> {
    const forced = force === 'true';
    if (forced && this.agents.isOnline(id)) throw new HttpException('The node is online. Delete its servers instead.', 409);
    await call(this.nats, Subjects.nodesRemove, { id, force: forced });
    this.agents.disconnect(id);
  }
}

@ApiTags('servers')
@Controller()
export class ServersController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get('servers')
  @ApiOkResponse({ type: [ServerDto] })
  list(@Req() req: AuthedRequest): Promise<ServerDto[]> {
    return call(this.nats, Subjects.serversList, { secrets: secrets(req) });
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
  get(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<ServerDto> {
    return call(this.nats, Subjects.serversGet, { id, secrets: secrets(req) });
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
  start(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStart, { id, secrets: secrets(req) });
  }

  /** Runs the install script again at the next start; the server must be stopped (ADR 0022). */
  @Post('servers/:id/reinstall')
  @Allow('manageServers')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  reinstall(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return call(this.nats, Subjects.serversReinstall, { id });
  }

  @Post('servers/:id/stop')
  @Allow('startStopServers')
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  stop(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<ServerDto> {
    return call(this.nats, Subjects.serversStop, { id, secrets: secrets(req) });
  }

  /** Deletes a stopped server with its data and backups on the node. Cannot be undone. */
  @Delete('servers/:id')
  @Allow('manageServers')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await call(this.nats, Subjects.serversDelete, { id }, 140_000); // the agent gets two minutes for large worlds
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
    return call(this.nats, Subjects.serversReadFile, { id, path }, AGENT_MS);
  }

  /** Replaces a config file the template lists. The server reads it on its next start. */
  @Put('servers/:id/files')
  @Allow('manageServers')
  @ApiBody({ type: WriteConfigFileDto })
  @ApiOkResponse({ type: ConfigFileDto })
  writeFile(@Param('id', ParseUUIDPipe) id: string, @Body() body: WriteConfigFileDto): Promise<ConfigFileDto> {
    return call(this.nats, Subjects.serversWriteFile, { id, path: body?.path, content: body?.content }, AGENT_MS);
  }

  @Post('servers/:id/command')
  @Allow('sendCommands')
  @ApiBody({ type: CommandDto })
  @ApiOkResponse({ type: ServerDto })
  @HttpCode(200)
  command(@Param('id', ParseUUIDPipe) id: string, @Body() body: CommandDto, @Req() req: AuthedRequest): Promise<ServerDto> {
    return call(this.nats, Subjects.serversCommand, { id, command: body?.command, secrets: secrets(req) });
  }
}

/** NATS side: the servers service asks the gateway to deliver messages to agents. */
@Controller()
export class AgentsNatsController {
  constructor(private readonly agents: AgentHub) {}

  // ponytail: one gateway instance; with several, route by node (e.g. subject per node)
  @MessagePattern(Subjects.agentsRequest)
  request(@Payload() payload: AgentsSendRequest): Promise<AgentsRequestReply> {
    // Downloads (ADR 0017) take longer than other requests; never more than 5 minutes.
    const ms = Math.min(Number(payload.timeoutMs) || 10_000, 300_000);
    return this.agents.request(payload.nodeId, payload.message as PanelMessage & { requestId: string }, ms);
  }

  @MessagePattern(Subjects.agentsSend)
  send(@Payload() payload: AgentsSendRequest): AgentsSendReply {
    return { delivered: this.agents.send(payload.nodeId, payload.message as PanelMessage) };
  }
}
