import { Controller, Get, Inject, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type SharePack, type ShareSummary } from '@harrier-gg/contracts';
import type { Response } from 'express';
import { Allow } from './auth/auth.guard';
import { NATS } from './nats';
import { call } from './servers.controllers';

class ShareModDto {
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
}

class ShareSummaryDto implements ShareSummary {
  @ApiProperty({ enum: ['mrpack'] }) format!: 'mrpack';
  @ApiProperty({ example: 'Survival.mrpack' }) fileName!: string;
  @ApiProperty({ type: [ShareModDto], description: 'Content players get' }) mods!: ShareModDto[];
  @ApiProperty({ type: [String], description: 'Content that cannot be in the pack' }) missing!: string[];
}

/** The content players need as one pack for their launcher (ADR 0018). Every member. */
@ApiTags('share')
@Controller('servers/:id/share')
export class ShareController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get()
  @Allow('viewServers')
  @ApiOkResponse({ type: ShareSummaryDto })
  summary(@Param('id', ParseUUIDPipe) id: string): Promise<ShareSummaryDto> {
    return call(this.nats, Subjects.serversShare, { id }, 15_000);
  }

  @Get('download')
  @Allow('viewServers')
  @ApiOkResponse({ description: 'The pack', content: { 'application/x-modrinth-modpack+zip': { schema: { type: 'string', format: 'binary' } } } })
  async download(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const pack = await call<SharePack>(this.nats, Subjects.serversSharePack, { id }, 15_000);
    res
      .status(200)
      .type('application/x-modrinth-modpack+zip')
      .setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(pack.fileName)}`)
      .send(Buffer.from(pack.data, 'base64'));
  }
}
