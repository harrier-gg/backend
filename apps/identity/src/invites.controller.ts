import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AcceptInviteSchema,
  ActorSchema,
  can,
  CreateInviteSchema,
  InviteIdSchema,
  InviteTokenSchema,
  RemoveUserSchema,
  Subjects,
  UpdateRoleSchema,
  type InviteCreated,
  type InviteSummary,
  type Reply,
  type Role,
  type SessionCreated,
  type UserListEntry,
} from '@harrier-gg/contracts';
import { config } from './config';
import { hashPassword, hashToken, newToken } from './crypto';
import type { Db } from './db';
import { Prisma } from './generated/prisma/client';
import { createSession, DB, fail, toUser } from './identity.controller';

const INVITE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** Roles a user may hand out or take away (ADR 0007): members by admins, admins only by the owner. */
export function mayManage(actor: Role, target: Role): boolean {
  if (target === 'owner') return false;
  return target === 'admin' ? can(actor, 'manageAdmins') : can(actor, 'manageMembers');
}

const toInvite = (i: { id: string; role: Role; createdAt: Date; expiresAt: Date; createdBy: { name: string } }): InviteSummary => ({
  id: i.id,
  role: i.role,
  createdBy: i.createdBy.name,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
});

@Controller()
export class InvitesController {
  private readonly logger = new Logger(InvitesController.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** The acting user's role from our own database, never from the request (ADR 0007). */
  private async actorRole(payload: unknown): Promise<Role | null> {
    const actor = ActorSchema.safeParse(payload);
    if (!actor.success) return null;
    const user = await this.db.user.findUnique({ where: { id: actor.data.actorId }, select: { role: true } });
    return user?.role ?? null;
  }

  @MessagePattern(Subjects.invitesCreate)
  async create(@Payload() payload: unknown): Promise<Reply<InviteCreated>> {
    const request = CreateInviteSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid invitation');
    const actor = await this.actorRole(payload);
    if (!actor || !mayManage(actor, request.data.role)) return fail(403, 'You may not invite this role');

    const { token, hash } = newToken();
    const invite = await this.db.invite.create({
      data: { tokenHash: hash, role: request.data.role, createdById: request.data.actorId, expiresAt: new Date(Date.now() + INVITE_DAYS * DAY) },
      include: { createdBy: { select: { name: true } } },
    });
    const url = new URL('/invite', config.HARRIER_PUBLIC_URL);
    url.searchParams.set('token', token);
    return { data: { invite: toInvite(invite), url: url.toString() } };
  }

  /** Open invitations: not used and not expired. */
  @MessagePattern(Subjects.invitesList)
  async list(@Payload() payload: unknown): Promise<Reply<InviteSummary[]>> {
    const actor = await this.actorRole(payload);
    if (!actor || !can(actor, 'manageMembers')) return fail(403, 'You may not see invitations');
    const invites = await this.db.invite.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
      include: { createdBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: invites.map(toInvite) };
  }

  @MessagePattern(Subjects.invitesRevoke)
  async revoke(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = InviteIdSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid invitation');
    const actor = await this.actorRole(payload);
    const invite = await this.db.invite.findUnique({ where: { id: request.data.id } });
    if (!invite || invite.usedAt) return fail(404, 'Invitation not found');
    if (!actor || !mayManage(actor, invite.role)) return fail(403, 'You may not revoke this invitation');
    await this.db.invite.delete({ where: { id: invite.id } });
    return { data: { ok: true } };
  }

  /** Public: lets the invite page show the role before the person signs up. */
  @MessagePattern(Subjects.invitesCheck)
  async check(@Payload() payload: unknown): Promise<Reply<{ role: Role }>> {
    const request = InviteTokenSchema.safeParse(payload);
    if (!request.success) return fail(404, 'The invitation is invalid, expired or already used');
    const invite = await this.db.invite.findUnique({ where: { tokenHash: hashToken(request.data.token) } });
    if (!invite || invite.usedAt || invite.expiresAt <= new Date()) return fail(404, 'The invitation is invalid, expired or already used');
    return { data: { role: invite.role } };
  }

  /** Creates the account and marks the invitation as used in one transaction (single use). */
  @MessagePattern(Subjects.invitesAccept)
  async accept(@Payload() payload: unknown): Promise<Reply<SessionCreated>> {
    const request = AcceptInviteSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Name, a valid e-mail address and a password of at least 10 characters are required');
    const { token, name, email, password } = request.data;
    const passwordHash = await hashPassword(password);

    try {
      const user = await this.db.$transaction(
        async (tx) => {
          const invite = await tx.invite.findUnique({ where: { tokenHash: hashToken(token) } });
          if (!invite || invite.usedAt || invite.expiresAt <= new Date()) throw new InviteError(404, 'The invitation is invalid, expired or already used');
          if (await tx.user.findUnique({ where: { email } })) throw new InviteError(409, 'An account with this e-mail address already exists');
          const created = await tx.user.create({ data: { email, name, passwordHash, role: invite.role } });
          await tx.invite.update({ where: { id: invite.id }, data: { usedAt: new Date(), usedById: created.id } });
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      this.logger.log(`${user.email} joined as ${user.role}`);
      return { data: await createSession(this.db, user) };
    } catch (error) {
      if (error instanceof InviteError) return fail(error.status, error.message);
      // A serialization conflict means someone used the same link at the same moment.
      return fail(409, 'The invitation is invalid, expired or already used');
    }
  }

  @MessagePattern(Subjects.usersList)
  async users(@Payload() payload: unknown): Promise<Reply<UserListEntry[]>> {
    const actor = await this.actorRole(payload);
    if (!actor || !can(actor, 'manageMembers')) return fail(403, 'You may not see users');
    const users = await this.db.user.findMany({ orderBy: { createdAt: 'asc' } });
    return { data: users.map((u) => ({ ...toUser(u), createdAt: u.createdAt.toISOString() })) };
  }

  @MessagePattern(Subjects.usersUpdateRole)
  async updateRole(@Payload() payload: unknown): Promise<Reply<UserListEntry>> {
    const request = UpdateRoleSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid role');
    const actor = await this.actorRole(payload);
    const target = await this.db.user.findUnique({ where: { id: request.data.userId } });
    if (!target) return fail(404, 'User not found');
    // Both the current and the new role must be manageable: only the owner promotes or demotes admins.
    if (!actor || !mayManage(actor, target.role) || !mayManage(actor, request.data.role)) return fail(403, 'You may not change this role');
    const user = await this.db.user.update({ where: { id: target.id }, data: { role: request.data.role } });
    return { data: { ...toUser(user), createdAt: user.createdAt.toISOString() } };
  }

  @MessagePattern(Subjects.usersRemove)
  async remove(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = RemoveUserSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid user');
    if (request.data.userId === request.data.actorId) return fail(400, 'You cannot remove yourself');
    const actor = await this.actorRole(payload);
    const target = await this.db.user.findUnique({ where: { id: request.data.userId } });
    if (!target) return fail(404, 'User not found');
    if (!actor || !mayManage(actor, target.role)) return fail(403, 'You may not remove this user');
    await this.db.user.delete({ where: { id: target.id } }); // sessions and their invitations go with it
    return { data: { ok: true } };
  }
}

class InviteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
