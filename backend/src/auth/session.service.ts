import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock/clock';
import { hashSessionToken, isSessionToken } from '../identity/session-token';
import { UserSession } from '../persistence/entities/user-session.entity';
import { User } from '../persistence/entities/user.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { SessionIdentity } from './authentication.service';
import { translateAuthPersistenceError } from './auth-errors';
import { SESSION_POLICY } from './session-policy';

export interface AuthenticatedSession extends SessionIdentity {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  renewed: boolean;
}
export const TOUCH_SESSION_SQL = "UPDATE user_sessions SET last_seen_at = $1::timestamptz, expires_at = LEAST(created_at + $2 * INTERVAL '1 second', $1::timestamptz + $3 * INTERVAL '1 second') WHERE id = $4 AND revoked_at IS NULL AND expires_at > $1::timestamptz RETURNING last_seen_at, expires_at";
export const REVOKE_SESSION_SQL = 'UPDATE user_sessions SET revoked_at = GREATEST($1::timestamptz, created_at) WHERE token_hash = $2 AND revoked_at IS NULL';
type SessionRead = UserSession & { user: User; membership: OrganizationMembership | null; organization: Organization | null };

@Injectable()
export class SessionService {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(UserSession) private readonly sessions: Repository<UserSession>,
  ) {}

  async authenticate(token: unknown): Promise<AuthenticatedSession | null> {
    if (!isSessionToken(token)) return null;
    try {
      const session = await this.sessions.createQueryBuilder('session')
        .innerJoinAndMapOne('session.user', User, 'user', 'user.id = session.userId')
        .leftJoinAndMapOne('session.membership', OrganizationMembership, 'membership',
          'membership.organizationId = session.activeOrganizationId AND membership.userId = session.userId AND membership.deactivatedAt IS NULL')
        .leftJoinAndMapOne('session.organization', Organization, 'organization', 'organization.id = session.activeOrganizationId')
        .where('session.tokenHash = :hash', { hash: hashSessionToken(token) }).getOne() as SessionRead | null;
      const now = this.clock.now();
      if (!session || session.revokedAt !== null || session.expiresAt <= now ||
          now.getTime() >= session.createdAt.getTime() + SESSION_POLICY.absoluteSeconds * 1000) return null;
      if (session.activeOrganizationId !== null && (!session.membership || session.membership.deactivatedAt !== null || !session.organization)) return null;
      let renewed = false;
      if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_POLICY.touchIntervalSeconds * 1000) {
        const [rows, affected] = await this.sessions.query(TOUCH_SESSION_SQL,
          [now, SESSION_POLICY.absoluteSeconds, SESSION_POLICY.idleSeconds, session.id]) as [{ last_seen_at: Date; expires_at: Date }[], number];
        if (affected !== 1) return null;
        session.lastSeenAt = rows[0].last_seen_at;
        session.expiresAt = rows[0].expires_at;
        renewed = true;
      }
      return { sessionId: session.id, user: { id: session.user.id, email: session.user.email, name: session.user.name },
        organization: session.activeOrganizationId !== null && session.organization ? { id: session.organization.id, name: session.organization.name } : null,
        membership: session.activeOrganizationId !== null && session.membership ? { id: session.membership.id, role: session.membership.role } : null,
        createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, renewed };
    } catch (error) { throw translateAuthPersistenceError(error); }
  }

  async revoke(token: unknown): Promise<boolean> {
    if (!isSessionToken(token)) return false;
    try {
      const [, affected] = await this.sessions.query(REVOKE_SESSION_SQL, [this.clock.now(), hashSessionToken(token)]) as [unknown[], number];
      return affected === 1;
    } catch (error) { throw translateAuthPersistenceError(error); }
  }
}
