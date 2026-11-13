import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock/clock';
import { UnauthenticatedError } from '../common/errors/domain-error';
import { IdGenerator } from '../common/ids/id-generator';
import { normalizeEmail } from '../identity/email';
import { PasswordHasher } from '../identity/password-hasher';
import { preparePassword } from '../identity/password-policy';
import { deriveCsrfToken, hashSessionToken, isSessionToken } from '../identity/session-token';
import { User } from '../persistence/entities/user.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { UserSession } from '../persistence/entities/user-session.entity';
import { TransactionRunner } from '../registration/transaction-runner';
import { translateAuthPersistenceError } from './auth-errors';
import { SESSION_POLICY } from './session-policy';

export const SESSION_TOKEN_FACTORY = Symbol('SESSION_TOKEN_FACTORY');
export interface SessionIdentity {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string } | null;
  membership: { id: string; role: string } | null;
}
export interface LoginResult extends SessionIdentity {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}
export const ROTATE_SESSION_SQL = 'UPDATE user_sessions SET revoked_at = GREATEST($1::timestamptz, created_at) WHERE token_hash = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > $1::timestamptz';

@Injectable()
export class AuthenticationService {
  private dummyHash?: Promise<string>;
  constructor(
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly runner: TransactionRunner,
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(SESSION_TOKEN_FACTORY) private readonly tokenFactory: () => string,
  ) {}

  private fictitiousHash(): Promise<string> {
    // Compartir incluso la generación en curso; un rechazo permite volver a intentarlo.
    this.dummyHash ??= this.hasher.hash(randomBytes(32).toString('base64url')).catch(error => {
      this.dummyHash = undefined;
      throw error;
    });
    return this.dummyHash;
  }

  async login(input: { email: unknown; password: unknown; presentedSessionToken?: unknown }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const password = preparePassword(input.password);
    try {
      const user = email !== null && password.ok ? await this.users.createQueryBuilder('user')
        .addSelect('user.passwordHash').where('user.email = :email', { email }).getOne() : null;
      const hash = user ? user.passwordHash : await this.fictitiousHash();
      const verified = await this.hasher.verify(hash, password.ok ? password.value : input.password);
      if (!user || !password.ok || !verified) throw new UnauthenticatedError('Credenciales inválidas.');
      return await this.runner.run(async manager => {
        const memberships = await manager.createQueryBuilder(OrganizationMembership, 'membership')
          .innerJoinAndMapOne('membership.organization', Organization, 'organization', 'organization.id = membership.organizationId')
          .where('membership.userId = :userId', { userId: user.id })
          .andWhere('membership.deactivatedAt IS NULL')
          .orderBy('membership.createdAt', 'ASC').addOrderBy('membership.id', 'ASC')
          .getMany() as (OrganizationMembership & { organization: Organization })[];
        if (memberships.length === 0) throw new UnauthenticatedError('Credenciales inválidas.');
        const active = memberships.length === 1 ? memberships[0] : null;
        const now = this.clock.now();
        const token = this.tokenFactory();
        const maxAgeSeconds = Math.min(SESSION_POLICY.idleSeconds, SESSION_POLICY.absoluteSeconds);
        const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000);
        if (isSessionToken(input.presentedSessionToken)) {
          await manager.query(ROTATE_SESSION_SQL, [now, hashSessionToken(input.presentedSessionToken), user.id]);
        }
        await manager.insert(UserSession, { id: this.ids.next(), tokenHash: hashSessionToken(token), userId: user.id,
          activeOrganizationId: active?.organizationId ?? null, createdAt: now, lastSeenAt: now, expiresAt, revokedAt: null });
        return { token, csrfToken: deriveCsrfToken(token), expiresAt, maxAgeSeconds,
          user: { id: user.id, email: user.email, name: user.name },
          organization: active ? { id: active.organization.id, name: active.organization.name } : null,
          membership: active ? { id: active.id, role: active.role } : null };
      });
    } catch (error) { throw translateAuthPersistenceError(error); }
  }
}
