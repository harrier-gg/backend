import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FilePathSchema, Subjects, type FileEntry, type ServerSummary } from '@harrier-gg/contracts';
import type { Request, Response } from 'express';
import type { WebSocket } from 'ws';
import { AgentHub } from './agents/agent-hub';
import { TransferHub } from './agents/transfer-hub';
import { Allow } from './auth/auth.guard';
import { NATS } from './nats';
import { AGENT_MS, call } from './servers.controllers';

class FileEntryDto implements FileEntry {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['file', 'dir', 'other'], description: 'other: symlinks and special files' }) kind!: 'file' | 'dir' | 'other';
  @ApiProperty({ description: 'Bytes; 0 for directories' }) size!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Last change, seconds since 1970' }) modified!: number | null;
}

class PathDto {
  @ApiProperty({ example: 'world/datapacks' }) path!: string;
}

class MoveDto {
  @ApiProperty({ example: 'plugins/old.jar' }) from!: string;
  @ApiProperty({ example: 'plugins/disabled/old.jar' }) to!: string;
}

/** Waits for the close of a transfer channel: code 1000 is success, 1011 carries the agent's error. */
const closed = (channel: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => channel.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));

/** File manager of a server (ADR 0015). Admins and owners, like config files. */
@ApiTags('files')
@Controller('servers/:id/files')
export class FilesController {
  constructor(
    @Inject(NATS) private readonly nats: ClientProxy,
    private readonly agents: AgentHub,
    private readonly transfers: TransferHub,
  ) {}

  /** A directory's entries, directories first. `path` empty: the server's data directory. */
  @Get('list')
  @Allow('manageServers')
  @ApiQuery({ name: 'path', required: false })
  @ApiOkResponse({ type: [FileEntryDto] })
  list(@Param('id', ParseUUIDPipe) id: string, @Query('path') path = ''): Promise<FileEntryDto[]> {
    return call(this.nats, Subjects.serversListDir, { id, path }, AGENT_MS);
  }

  /** Deletes a file, or a directory with everything in it. */
  @Delete()
  @Allow('manageServers')
  @ApiQuery({ name: 'path' })
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('path') path: string): Promise<void> {
    await call(this.nats, Subjects.serversDeletePath, { id, path }, AGENT_MS);
  }

  @Post('mkdir')
  @Allow('manageServers')
  @ApiBody({ type: PathDto })
  @HttpCode(204)
  async mkdir(@Param('id', ParseUUIDPipe) id: string, @Body() body: PathDto): Promise<void> {
    await call(this.nats, Subjects.serversMakeDir, { id, path: body?.path }, AGENT_MS);
  }

  /** Renames or moves; fails if the target exists. */
  @Post('move')
  @Allow('manageServers')
  @ApiBody({ type: MoveDto })
  @HttpCode(204)
  async move(@Param('id', ParseUUIDPipe) id: string, @Body() body: MoveDto): Promise<void> {
    await call(this.nats, Subjects.serversMovePath, { id, from: body?.from, to: body?.to }, AGENT_MS);
  }

  /** Streams a file from the agent to the browser over a transfer channel. */
  @Get('download')
  @Allow('manageServers')
  @ApiQuery({ name: 'path' })
  @ApiOkResponse({ description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } })
  async download(@Param('id', ParseUUIDPipe) id: string, @Query('path') path: string, @Res() res: Response): Promise<void> {
    const channel = await this.channel(id, path, 'sendFile');
    const name = path.split('/').pop()!;
    const start = () => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    };
    channel.on('message', (data: Buffer) => {
      start();
      if (!res.write(data)) {
        channel.pause(); // the browser is slower than the agent
        res.once('drain', () => channel.resume());
      }
    });
    res.on('close', () => channel.close(4000, 'Cancelled'));
    const { code, reason } = await closed(channel);
    if (code === 1000) {
      start();
      res.end();
    } else if (!res.headersSent) {
      res.status(422).type('application/problem+json').json({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: reason || 'The download failed' });
    } else {
      res.destroy(); // broken off mid-file: the browser marks the download as failed
    }
  }

  /** Streams the request body to the agent; the file appears only once it is complete. */
  @Put('upload')
  @Allow('manageServers')
  @ApiQuery({ name: 'path', description: 'Where to put the file, e.g. plugins/x.jar' })
  @ApiBody({ description: 'The file', required: true, schema: { type: 'string', format: 'binary' } })
  @HttpCode(204)
  async upload(@Param('id', ParseUUIDPipe) id: string, @Query('path') path: string, @Req() req: Request): Promise<void> {
    const channel = await this.channel(id, path, 'receiveFile');
    const done = closed(channel);
    try {
      for await (const chunk of req) {
        // One frame at a time, so a slow disk on the node slows the upload instead of filling memory.
        await new Promise<void>((resolve, reject) => channel.send(chunk as Buffer, { binary: true }, (e) => (e ? reject(e) : resolve())));
      }
      channel.send('done');
    } catch {
      channel.close(4000, 'Cancelled'); // browser gone or agent failed; the agent drops the partial file
    }
    const { code, reason } = await done;
    if (code !== 1000) throw new HttpException(reason || 'The upload failed', 422);
  }

  /** Asks the server's agent to open a transfer channel and waits for it. */
  private async channel(id: string, path: string, type: 'sendFile' | 'receiveFile'): Promise<WebSocket> {
    if (!FilePathSchema.safeParse(path).success) throw new HttpException('Invalid path', 400);
    const server = await call<ServerSummary>(this.nats, Subjects.serversGet, { id });
    const transfer = this.transfers.open(server.nodeId);
    if (!this.agents.send(server.nodeId, { type, transferId: transfer.id, serverId: id, path })) {
      throw new HttpException('The node is offline. Start its agent and try again.', 409);
    }
    const channel = await transfer.channel;
    if (!channel) throw new HttpException('The agent did not open a transfer channel. It may be too old; update it.', 504);
    return channel;
  }
}
