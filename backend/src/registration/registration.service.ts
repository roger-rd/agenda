import { Inject, Injectable } from '@nestjs/common';
import { InvalidInputError } from '../common/errors/domain-error';
import { IdGenerator } from '../common/ids/id-generator';
import { normalizeEmail } from '../identity/email';
import { normalizePersonName, organizationNameKey } from '../identity/person-name';
import { PasswordHasher } from '../identity/password-hasher';
import { preparePassword } from '../identity/password-policy';
import { User } from '../persistence/entities/user.entity';
import { Organization } from '../persistence/entities/organization.entity';
import { OrganizationMembership } from '../persistence/entities/organization-membership.entity';
import { TransactionRunner } from './transaction-runner';
import { translateRegistrationError } from './registration-errors';

export const REGISTRATION_NOW = Symbol('REGISTRATION_NOW');
export const REGISTRATION_NORMALIZERS = Symbol('REGISTRATION_NORMALIZERS');
export const registrationNormalizers = { normalizeEmail, normalizePersonName, organizationNameKey };
export interface RegistrationInput { email: unknown; password: unknown; name: unknown; organizationName: unknown }
export interface RegistrationResult {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string };
  membership: { id: string; role: 'community_manager' };
}

@Injectable()
export class RegistrationService {
  constructor(
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly runner: TransactionRunner,
    @Inject(REGISTRATION_NOW) private readonly now: () => Date,
    @Inject(REGISTRATION_NORMALIZERS) private readonly normalizers: typeof registrationNormalizers,
  ) {}

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const email = this.normalizers.normalizeEmail(input.email);
    if (email === null) throw new InvalidInputError('Datos de entrada inválidos.', 'email');
    const name = this.normalizers.normalizePersonName(input.name);
    if (name === null) throw new InvalidInputError('Datos de entrada inválidos.', 'name');
    const organizationName = this.normalizers.normalizePersonName(input.organizationName);
    const nameKey = organizationName === null ? null : this.normalizers.organizationNameKey(organizationName);
    if (organizationName === null || nameKey === null) throw new InvalidInputError('Datos de entrada inválidos.', 'organizationName');
    const password = preparePassword(input.password);
    if (!password.ok) throw new InvalidInputError('Datos de entrada inválidos.', 'password');
    const passwordHash = await this.hasher.hash(password.value);
    const now = this.now();
    try {
      return await this.runner.run(async manager => {
        const common = { version: 1, createdAt: now, updatedAt: now };
        const user = { ...common, id: this.ids.next(), email, name, passwordHash, passwordChangedAt: now } satisfies Pick<User, 'id' | 'email' | 'name' | 'passwordHash' | 'passwordChangedAt' | 'version' | 'createdAt' | 'updatedAt'>;
        await manager.insert(User, user);
        const organization = { ...common, id: this.ids.next(), name: organizationName, nameKey } satisfies Organization;
        await manager.insert(Organization, organization);
        const membership = { ...common, id: this.ids.next(), organizationId: organization.id, userId: user.id,
          role: 'community_manager' as const, deactivatedAt: null } satisfies OrganizationMembership;
        await manager.insert(OrganizationMembership, membership);
        return { user: { id: user.id, email, name }, organization: { id: organization.id, name: organizationName },
          membership: { id: membership.id, role: membership.role } };
      });
    } catch (error) { throw translateRegistrationError(error); }
  }
}
