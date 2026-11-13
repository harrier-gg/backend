import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Subjects, type ContentProject, type ContentSide, type ContentUpdate, type InstalledContent } from '@harrier-gg/contracts';
import { Allow } from './auth/auth.guard';
import { NATS } from './nats';
import { call } from './servers.controllers';

const SIDES = ['server', 'client', 'both'];

export class ContentProjectDto implements ContentProject {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() summary!: string;
  @ApiProperty() author!: string;
  @ApiProperty() downloads!: number;
  @ApiProperty({ type: String, nullable: true }) iconUrl!: string | null;
  @ApiProperty() pageUrl!: string;
  @ApiProperty({ type: String, nullable: true, enum: SIDES, description: 'client: only players need it' }) side!: ContentSide | null;
}

class InstalledContentDto implements InstalledContent {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'mod' }) kind!: string;
  @ApiProperty({ example: 'modrinth' }) provider!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ example: 'mods/fabric-api.jar' }) path!: string;
  @ApiProperty({ type: String, nullable: true, enum: SIDES }) side!: ContentSide | null;
  @ApiProperty({ description: 'Installed because another project needs it' }) dependency!: boolean;
  @ApiProperty({ format: 'date-time' }) installedAt!: string;
}

class ContentUpdateDto implements ContentUpdate {
  @ApiProperty() contentId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The newer version; null if nothing fits the server any more' }) version!: string | null;
  @ApiProperty({ description: 'No version fits the server\'s game version' }) incompatible!: boolean;
}

class InstallDto {
  @ApiProperty({ example: 'mod' }) kind!: string;
  @ApiProperty({ example: 'modrinth' }) source!: string;
  @ApiProperty({ example: 'P7dR8mSH' }) projectId!: string;
}

/** Mods, plugins and other content of a server (ADR 0017). Admins and owners. */
@ApiTags('content')
@Controller('servers/:id/content')
export class ContentController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get()
  @Allow('manageServers')
  @ApiOkResponse({ type: [InstalledContentDto] })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<InstalledContentDto[]> {
    return call(this.nats, Subjects.serversContentList, { id });
  }

  /** Searches one source of a content kind, filtered to the server's game version. */
  @Get('search')
  @Allow('manageServers')
  @ApiQuery({ name: 'kind', example: 'mod' })
  @ApiQuery({ name: 'source', example: 'modrinth' })
  @ApiQuery({ name: 'query', required: false })
  @ApiOkResponse({ type: [ContentProjectDto] })
  search(@Param('id', ParseUUIDPipe) id: string, @Query('kind') kind: string, @Query('source') source: string, @Query('query') query = ''): Promise<ContentProjectDto[]> {
    return call(this.nats, Subjects.serversContentSearch, { id, kind, source, query }, 20_000);
  }

  /** Installs a project and its required dependencies; returns what was installed. */
  @Post()
  @Allow('manageServers')
  @ApiBody({ type: InstallDto })
  @ApiOkResponse({ type: [InstalledContentDto] })
  @HttpCode(200)
  install(@Param('id', ParseUUIDPipe) id: string, @Body() body: InstallDto): Promise<InstalledContentDto[]> {
    // Several downloads of up to 2 minutes each.
    return call(this.nats, Subjects.serversContentInstall, { id, kind: body?.kind, source: body?.source, projectId: body?.projectId }, 600_000);
  }

  /** Content with a newer fitting version, or none that fits the server's game version any more. */
  @Get('updates')
  @Allow('manageServers')
  @ApiOkResponse({ type: [ContentUpdateDto] })
  updates(@Param('id', ParseUUIDPipe) id: string): Promise<ContentUpdateDto[]> {
    return call(this.nats, Subjects.serversContentUpdates, { id }, 60_000);
  }

  /** Updates to the newest fitting version and installs dependencies it needs; returns what changed. */
  @Post(':contentId/update')
  @Allow('manageServers')
  @ApiOkResponse({ type: [InstalledContentDto] })
  @HttpCode(200)
  update(@Param('id', ParseUUIDPipe) id: string, @Param('contentId', ParseUUIDPipe) contentId: string): Promise<InstalledContentDto[]> {
    return call(this.nats, Subjects.serversContentUpdate, { id, contentId }, 600_000);
  }

  /** Removes content and the dependencies nobody needs any more; returns everything removed. */
  @Delete(':contentId')
  @Allow('manageServers')
  @ApiOkResponse({ type: [InstalledContentDto] })
  remove(@Param('id', ParseUUIDPipe) id: string, @Param('contentId', ParseUUIDPipe) contentId: string): Promise<InstalledContentDto[]> {
    return call(this.nats, Subjects.serversContentRemove, { id, contentId }, 60_000);
  }
}
