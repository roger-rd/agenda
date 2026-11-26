import { CompaniesController } from './companies/companies.controller';
import { InvitationsController } from './invitations/invitations.controller';
import { InvitationAcceptanceController } from './invitations/invitation-acceptance.controller';
import { InvitationAcceptanceService } from './invitations/invitation-acceptance.service';
import { SESSION_TOKEN_FACTORY } from './auth/authentication.service';
import { InvitationsService } from './invitations/invitations.service';
import { InvitationTokens, RandomInvitationTokens } from './invitations/invitation-token';
import { Company } from './persistence/entities/company.entity';
import { CompanyAccess } from './persistence/entities/company-access.entity';
import { AuthController } from './auth/auth.controller';
import { AuthenticationService } from './auth/authentication.service';
import { PasswordHasher } from './identity/password-hasher';
import { LimitedPasswordHasher } from './identity/limited-password-hasher';
import { UserSession } from './persistence/entities/user-session.entity';
import { RegistrationController } from './registration/registration.controller';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TransactionRunner } from './registration/transaction-runner';
import { RegistrationService } from './registration/registration.service';
import { User } from './persistence/entities/user.entity';
import { Organization } from './persistence/entities/organization.entity';
import { OrganizationMembership } from './persistence/entities/organization-membership.entity';
import 'reflect-metadata';
import { ConstraintRegistry } from './database/errors/constraint-registry';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';

@Module({ providers: [ConstraintRegistry], exports: [ConstraintRegistry] })
class TestDatabaseModule {}
import { Test } from '@nestjs/testing';

import { configureHttpApp } from './common/http/configure-http-app';

const originalEnv = { ...process.env };
beforeAll(() => {
  process.env = { NODE_ENV: 'test', DATABASE_NAME: 'agenda_test', DATABASE_USER: 'agenda_test_app',
    DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001' };
});
afterAll(() => { process.env = originalEnv; });

describe('AppModule', () => {
  it('compila el módulo y crea una aplicación sin abrir puertos', async () => {
    const { AppModule } = await import('./app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideModule(DatabaseModule).useModule(TestDatabaseModule)
      // forFeature registra repositorios; reemplazarlos junto al runner evita necesitar DataSource.
      .overrideProvider(TransactionRunner).useValue({ run: jest.fn() })
      .overrideProvider(getRepositoryToken(Company)).useValue({ query: jest.fn() })
      .overrideProvider(getRepositoryToken(CompanyAccess)).useValue({})
      .overrideProvider(getRepositoryToken(UserSession)).useValue({})
      .overrideProvider(getRepositoryToken(User)).useValue({})
      .overrideProvider(getRepositoryToken(Organization)).useValue({})
      .overrideProvider(getRepositoryToken(OrganizationMembership)).useValue({})
      .compile();

    const app = moduleRef.createNestApplication();
    try {
      await configureHttpApp(app);
      await app.init();
      expect(moduleRef.get(RegistrationService)).toBeInstanceOf(RegistrationService);
      expect(moduleRef.get(RegistrationController)).toBeInstanceOf(RegistrationController);
      expect(Reflect.getMetadata(PATH_METADATA, RegistrationController)).toBe('auth');
      expect(Reflect.getMetadata(PATH_METADATA, RegistrationController.prototype.register)).toBe('register');
      expect(Reflect.getMetadata(METHOD_METADATA, RegistrationController.prototype.register)).toBe(RequestMethod.POST);
      expect(moduleRef.get(AuthController)).toBeInstanceOf(AuthController);
      expect(Reflect.getMetadata(PATH_METADATA, AuthController)).toBe('auth');
      for (const [name, method] of [['login', RequestMethod.POST], ['session', RequestMethod.GET], ['logout', RequestMethod.POST]] as const) {
        expect(Reflect.getMetadata(PATH_METADATA, AuthController.prototype[name])).toBe(name);
        expect(Reflect.getMetadata(METHOD_METADATA, AuthController.prototype[name])).toBe(method);
      }
      const hasher = moduleRef.get(PasswordHasher);
      expect(hasher).toBeInstanceOf(LimitedPasswordHasher);
      expect((moduleRef.get(AuthenticationService) as unknown as { hasher: PasswordHasher }).hasher).toBe(hasher);
      expect((moduleRef.get(RegistrationService) as unknown as { hasher: PasswordHasher }).hasher).toBe(hasher);
      expect(moduleRef.get(CompaniesController)).toBeInstanceOf(CompaniesController);
      expect(Reflect.getMetadata(PATH_METADATA, CompaniesController)).toBe('companies');
      expect(Reflect.getMetadata(PATH_METADATA, CompaniesController.prototype.list)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, CompaniesController.prototype.list)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(METHOD_METADATA, CompaniesController.prototype.create)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(METHOD_METADATA, CompaniesController.prototype.update)).toBe(RequestMethod.PATCH);
      expect(Reflect.getMetadata(PATH_METADATA, CompaniesController.prototype.update)).toBe(':id');
      expect(moduleRef.get(InvitationsController)).toBeInstanceOf(InvitationsController);
      expect(moduleRef.get(InvitationsService)).toBeInstanceOf(InvitationsService);
      expect(moduleRef.get(InvitationTokens)).toBeInstanceOf(RandomInvitationTokens);
      expect(Reflect.getMetadata(PATH_METADATA, InvitationsController)).toBe('invitations');
      for (const [name, method, path] of [['create', RequestMethod.POST, '/'], ['list', RequestMethod.GET, '/'], ['revoke', RequestMethod.POST, ':id/revoke'], ['renew', RequestMethod.POST, ':id/renew']] as const) {
        expect(Reflect.getMetadata(METHOD_METADATA, InvitationsController.prototype[name])).toBe(method);
        expect(Reflect.getMetadata(PATH_METADATA, InvitationsController.prototype[name])).toBe(path);
      }
      // Public acceptance routes: same limited hasher instance as registration and login, and the shared session token factory.
      expect(moduleRef.get(InvitationAcceptanceController)).toBeInstanceOf(InvitationAcceptanceController);
      const acceptance = moduleRef.get(InvitationAcceptanceService) as unknown as { hasher: PasswordHasher; newSessionToken: () => string };
      expect(acceptance.hasher).toBe(hasher);
      expect(acceptance.newSessionToken).toBe(moduleRef.get(SESSION_TOKEN_FACTORY, { strict: false }));
      expect(Reflect.getMetadata(PATH_METADATA, InvitationAcceptanceController)).toBe('invitations');
      for (const [name, path] of [['inspect', 'inspect'], ['accept', 'accept']] as const) {
        expect(Reflect.getMetadata(METHOD_METADATA, InvitationAcceptanceController.prototype[name])).toBe(RequestMethod.POST);
        expect(Reflect.getMetadata(PATH_METADATA, InvitationAcceptanceController.prototype[name])).toBe(path);
      }
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
