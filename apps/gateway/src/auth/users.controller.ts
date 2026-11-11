import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type InviteCreated, type InviteSummary, type Reply, type Role, type UserListEntry } from '@harrier-gg/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { NATS } from '../nats';
import { Allow, type AuthedRequest } from './auth.guard';

const ROLES = ['owner', 'admin', 'member'];

export class UserEntryDto implements UserListEntry {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class InviteDto implements InviteSummary {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['admin', 'member'] }) role!: Role;
  @ApiProperty({ description: 'Name of the person who created the invitation' }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

class InviteCreatedDto implements InviteCreated {
  @ApiProperty({ type: InviteDto }) invite!: InviteDto;
  @ApiProperty({ description: 'Link to share. Shown only once.' }) url!: string;
}

class CreateInviteDto {
  @ApiProperty({ enum: ['admin', 'member'] }) role!: 'admin' | 'member';
}

class UpdateRoleDto {
  @ApiProperty({ enum: ['admin', 'member'] }) role!: 'admin' | 'member';
}

/** Calls the identity service; `{ error }` replies become problem details. */
export async function callIdentity<T>(nats: ClientProxy, subject: string, payload: unknown): Promise<T> {
  const reply = await firstValueFrom(nats.send<Reply<T>>(subject, payload).pipe(timeout(10_000))).catch(() => {
    throw new HttpException('The identity service is unavailable', 503);
  });
  if ('error' in reply) throw new HttpException(reply.error.detail, reply.error.status);
  return reply.data;
}

/**
 * Users and invitations (ADR 0007). The gateway checks the coarse permission; the identity service
 * checks again with the role from its own database (e.g. only the owner may manage admins).
 */
@ApiTags('users')
@Allow('manageMembers')
@Controller()
export class UsersController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get('users')
  @ApiOkResponse({ type: [UserEntryDto] })
  list(@Req() req: AuthedRequest): Promise<UserEntryDto[]> {
    return callIdentity(this.nats, Subjects.usersList, { actorId: req.user.id });
  }

  @Patch('users/:id')
  @ApiBody({ type: UpdateRoleDto })
  @ApiOkResponse({ type: UserEntryDto })
  updateRole(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto): Promise<UserEntryDto> {
    return callIdentity(this.nats, Subjects.usersUpdateRole, { actorId: req.user.id, userId: id, role: body?.role });
  }

  @Delete('users/:id')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await callIdentity(this.nats, Subjects.usersRemove, { actorId: req.user.id, userId: id });
  }

  @Get('invites')
  @ApiOkResponse({ type: [InviteDto] })
  invites(@Req() req: AuthedRequest): Promise<InviteDto[]> {
    return callIdentity(this.nats, Subjects.invitesList, { actorId: req.user.id });
  }

  @Post('invites')
  @HttpCode(200)
  @ApiBody({ type: CreateInviteDto })
  @ApiOkResponse({ type: InviteCreatedDto })
  createInvite(@Req() req: AuthedRequest, @Body() body: CreateInviteDto): Promise<InviteCreatedDto> {
    return callIdentity(this.nats, Subjects.invitesCreate, { actorId: req.user.id, role: body?.role });
  }

  @Delete('invites/:id')
  @HttpCode(204)
  async revokeInvite(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await callIdentity(this.nats, Subjects.invitesRevoke, { actorId: req.user.id, id });
  }
}
