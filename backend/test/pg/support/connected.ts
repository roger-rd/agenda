import { registerMembersTest } from './http-members';
import { membersCleanupTargets, membersMarkers } from './members-fixture';
import { registerAcceptanceTest } from './http-acceptance';
import { acceptanceCleanupTargets, acceptanceMarkers } from './acceptance-fixture';
import { registerInvitationsTest } from './http-invitations';
import { invitationsMarkers, invitationsCleanupTargets, invitationsCleanupSQL, invitationsCleanupByIdSQL, invitationsSQL, type InvitationsSaved } from './invitations-fixture';
import { CapturingLoggingModule, logCapture } from './invitations-logging';
import { LoggingModule } from '../../../src/logging/logging.module';
import { registerCompaniesWriteTest } from './http-companies-write';
import { companiesWriteMarkers, companiesWriteCleanupTargets, companiesWriteCleanupSQL } from './companies-write-fixture';
import { registerCompaniesTest } from './http-companies';
import { companiesMarkers, companiesCleanupSQL, companiesCleanupTargets, type CompaniesSaved } from './companies-fixture';
import { Clock } from '../../../src/common/clock/clock';
import { assertAuthOrigin, ControlledClock } from './auth-controls';
import { registerAuthTest } from './http-auth';
import { registerHttpTest } from './http-register';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager, type Logger } from 'typeorm';
import { validateDatabaseEnvironment } from '../../../src/config/database-environment';
import { createDataSourceOptions } from '../../../src/database/data-source-options';
import { evaluateDatabaseIdentity } from '../../../src/database/database-identity.service';
import { ConstraintRegistry } from '../../../src/database/errors/constraint-registry';
import { configureHttpApp } from '../../../src/common/http/configure-http-app';
import { RegistrationService, REGISTRATION_NOW, REGISTRATION_NORMALIZERS, type RegistrationResult } from '../../../src/registration/registration.service';
import { DataSourceTransactionRunner, TransactionRunner } from '../../../src/registration/transaction-runner';
import { PasswordHasher } from '../../../src/identity/password-hasher';
import { IdGenerator } from '../../../src/common/ids/id-generator';
import { Company } from '../../../src/persistence/entities/company.entity';
import { CompanyAccess } from '../../../src/persistence/entities/company-access.entity';
import { UserSession } from '../../../src/persistence/entities/user-session.entity';
import { User } from '../../../src/persistence/entities/user.entity';
import { Organization } from '../../../src/persistence/entities/organization.entity';
import { OrganizationMembership } from '../../../src/persistence/entities/organization-membership.entity';
import { ConflictError, InvalidInputError } from '../../../src/common/errors/domain-error';
import { classifyDatabaseError } from '../../../src/database/errors/database-failure';
import { DatabaseOperationError } from '../../../src/database/errors/database-operation-error';
import { normalizePersonName, organizationNameKey } from '../../../src/identity/person-name';
import { normalizeEmail } from '../../../src/identity/email';
import { authCleanupSQL, authCleanupTargets, DeleteGate, httpCleanupSQL, httpCleanupTargets, markers, runId, validateRunId } from './markers';
import { accepted, checkRejected, columnTypeRejected, collisions, distinct, normalizerRejected } from './unicode-cases';
import { assertNodeTimeZone, parseAcceptanceTimeZone, parseInvitationTimeZone, parseMembersTimeZone, type Phase } from './phase';
import { assertFingerprint, businessFingerprint, migrationFingerprint, fingerprintSQL } from './schema-fingerprint';
import { expectedMigrations, migrationHistorySQL, classifyMigrationHistory, type MigrationHistory } from './migration-history';

// Arnes estricto: no ejecutar fases connected antes de aplicar ambas migraciones en agenda_test.
const tables = ['organizations', 'users', 'organization_memberships', 'companies', 'company_accesses', 'user_sessions', 'posts', 'post_comments', 'invitations', 'invitation_companies'] as const;
const identitySQL = "select current_user as usuario, current_database() as base, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, has_schema_privilege(current_user, 'public', 'CREATE') as crea_en_public, has_database_privilege(current_user, current_database(), 'CREATE') as crea_en_base from pg_roles r where r.rolname = current_user";
const sessionSQL = "SELECT pid, backend_start FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND application_name = 'agenda-backend'";
const roSQL = "SELECT pg_sleep(0.2), pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro, current_setting('default_transaction_read_only') AS dro";
// No query or parameter logging: failures are asserted via sanitized classification.
const logger: Logger = { logQuery() {}, logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
type Session = { pid: number; backend_start: Date };
const failure = (error: unknown) => error instanceof DatabaseOperationError ? error.failure : classifyDatabaseError(error);

export function registerConnectedSuite(phase: Exclude<Phase, 'offline'>): void {
  if (phase === 'auth' || phase === 'companies-write' || phase === 'invitations') assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS);
  // The zone reaches every connection through PGOPTIONS (set by the setup file from AGENDA_B2B_TIMEZONE); verify it before connecting.
  const zone = phase === 'invitations' ? parseInvitationTimeZone(process.env.AGENDA_B2B_TIMEZONE) : undefined;
  if (zone !== undefined) {
    if (process.env.PGOPTIONS !== `-c TimeZone=${zone}`) throw new Error('PGOPTIONS no corresponde a AGENDA_B2B_TIMEZONE: el archivo de preparación no se ejecutó');
    assertNodeTimeZone(process.env, Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  if (phase === 'acceptance') assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS);
  const acceptanceZone = phase === 'acceptance' ? parseAcceptanceTimeZone(process.env.AGENDA_B2B_TIMEZONE) : undefined;
  if (acceptanceZone !== undefined && process.env.PGOPTIONS !== `-c TimeZone=${acceptanceZone}`) {
    throw new Error('PGOPTIONS no corresponde a AGENDA_B2B_TIMEZONE: el archivo de preparación no se ejecutó');
  }
  if (phase === 'members') assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS);
  const membersZone = phase === 'members' ? parseMembersTimeZone(process.env.AGENDA_B2B_TIMEZONE) : undefined;
  if (membersZone !== undefined && process.env.PGOPTIONS !== `-c TimeZone=${membersZone}`) {
    throw new Error('PGOPTIONS no corresponde a AGENDA_B2B_TIMEZONE: el archivo de preparación no se ejecutó');
  }
  describe(`B2B ${phase}`, () => {
    const id = runId(), gate = new DeleteGate(phase), saved: RegistrationResult[] = [];
    const httpTargets = phase === 'http' ? httpCleanupTargets(id) : undefined;
    const authTargets = phase === 'auth' ? authCleanupTargets(id) : undefined;
    const companiesTargets = phase === 'companies' ? companiesCleanupTargets(id) : undefined;
    const companiesReservations = phase === 'companies' ? companiesMarkers(id) : undefined;
    const companiesSaved: CompaniesSaved = { users: [], memberships: [], companies: [] };
    const companiesWriteReservations = phase === 'companies-write' ? companiesWriteMarkers(id) : undefined;
    const companiesWriteTargets = phase === 'companies-write' ? companiesWriteCleanupTargets(id) : undefined;
    const invitationsReservations = phase === 'invitations' ? invitationsMarkers(id) : undefined;
    const invitationsTargets = phase === 'invitations' ? invitationsCleanupTargets(id) : undefined;
    const invitationsSaved: InvitationsSaved = { users: [], memberships: [], companies: [], invitations: [] };
    let locker: DataSource | undefined;
    const acceptanceReservations = phase === 'acceptance' ? acceptanceMarkers(id) : undefined;
    const acceptanceTargets = phase === 'acceptance' ? acceptanceCleanupTargets(id) : undefined;
    const acceptanceSaved: InvitationsSaved = { users: [], memberships: [], companies: [], invitations: [] };
    const membersReservations = phase === 'members' ? membersMarkers(id) : undefined;
    const membersTargets = phase === 'members' ? membersCleanupTargets(id) : undefined;
    const membersSaved: InvitationsSaved = { users: [], memberships: [], companies: [], invitations: [] };
    let clock: ControlledClock;
    let observer: DataSource | undefined, source: DataSource, app: INestApplication | undefined, moduleRef: TestingModule | undefined;
    let service: RegistrationService, sequence = 0, ready = false;
    let migrationHistory: MigrationHistory = 'unverified';
    let beforePids = new Set<number>(), ownSessions: Session[] = [];
    const input = (suffix = `org-${sequence}`) => ({ ...markers(id, sequence++, suffix), name: 'B2B Tester', password: 'B2b-test-only-long-passphrase-2026!' });
    async function counts(): Promise<number[]> {
      return Promise.all(tables.map(async table => {
        const rows: { n: number }[] = await observer!.query(`SELECT count(*)::int AS n FROM public.${table}`);
        return rows[0].n;
      }));
    }
    async function empty(): Promise<void> {
      const values = await counts();
      const occupied = tables.filter((_, i) => values[i] !== 0);
      if (occupied.length) throw new Error(`[b2b] runId=${id}: tablas no vacías ${occupied.join(', ')}; conteos=${values.join(',')}`);
    }
    async function cleanup(): Promise<void> {
      gate.assertArmed(); validateRunId(id);
      const userIds = saved.map(r => r.user.id), orgIds = saved.map(r => r.organization.id);
      if (companiesWriteTargets) { await cleanupCompaniesWrite(userIds, orgIds); return; }
      if (companiesTargets) { await cleanupCompanies(userIds, orgIds); return; }
      if (invitationsTargets) { await cleanupInvitations(userIds, orgIds); return; }
      if (acceptanceTargets) { await cleanupAcceptance(userIds, orgIds); return; }
      if (membersTargets) { await cleanupMembers(userIds, orgIds); return; }
      await observer!.query('DELETE FROM public.invitation_companies WHERE organization_id = ANY($1::uuid[])', [orgIds]);
      await observer!.query('DELETE FROM public.invitations WHERE organization_id = ANY($1::uuid[])', [orgIds]);
      await observer!.query('DELETE FROM public.user_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      if (authTargets) {
        await observer!.query('DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[])', [saved.map(r => r.membership.id)]);
      }
      // First saved ids, then exact HTTP reservations or DML run patterns. Always WHERE.
      if (httpTargets) {
        await observer!.query('DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[])', [saved.map(r => r.membership.id)]);
      }
      await observer!.query('DELETE FROM public.organization_memberships WHERE user_id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])', [userIds, orgIds]);
      await observer!.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [userIds]);
      await observer!.query('DELETE FROM public.organizations WHERE id = ANY($1::uuid[])', [orgIds]);
      if (httpTargets) {
        await observer!.query(httpCleanupSQL.invitationCompanies, [httpTargets.organizationNames]);
        await observer!.query(httpCleanupSQL.invitations, [httpTargets.organizationNames]);
        await observer!.query(httpCleanupSQL.sessions, [httpTargets.emails]);
        await observer!.query(httpCleanupSQL.memberships, [httpTargets.emails, httpTargets.organizationNames]);
        await observer!.query(httpCleanupSQL.users, [httpTargets.emails]);
        await observer!.query(httpCleanupSQL.organizations, [httpTargets.organizationNames]);
      } else if (authTargets) {
        await observer!.query(authCleanupSQL.invitationCompanies, [authTargets.organizationNames]);
        await observer!.query(authCleanupSQL.invitations, [authTargets.organizationNames]);
        await observer!.query(authCleanupSQL.sessions, [authTargets.emails]);
        await observer!.query(authCleanupSQL.memberships, [authTargets.emails, authTargets.organizationNames]);
        await observer!.query(authCleanupSQL.users, [authTargets.emails]);
        await observer!.query(authCleanupSQL.organizations, [authTargets.organizationNames]);
      } else {
        const emailPattern = `^b2b-${id}-[0-9]+@agenda-b2b[.]test$`, orgPattern = `B2B-${id}-%`;
        await observer!.query('DELETE FROM public.invitation_companies WHERE organization_id IN (SELECT id FROM public.organizations WHERE name LIKE $1)', [orgPattern]);
        await observer!.query('DELETE FROM public.invitations WHERE organization_id IN (SELECT id FROM public.organizations WHERE name LIKE $1)', [orgPattern]);
        await observer!.query('DELETE FROM public.user_sessions WHERE user_id IN (SELECT id FROM public.users WHERE email ~ $1)', [emailPattern]);
        await observer!.query('DELETE FROM public.organization_memberships WHERE user_id IN (SELECT id FROM public.users WHERE email ~ $1) OR organization_id IN (SELECT id FROM public.organizations WHERE name LIKE $2)', [emailPattern, orgPattern]);
        await observer!.query('DELETE FROM public.users WHERE email ~ $1', [emailPattern]);
        await observer!.query('DELETE FROM public.organizations WHERE name LIKE $1', [orgPattern]);
      }
      await empty();
    }
    async function cleanupCompanies(userIds: string[], orgIds: string[]): Promise<void> {
      gate.assertArmed();
      if (!companiesTargets) throw new Error('companies requiere reservas');
      const users = [...userIds, ...companiesSaved.users], memberships = [...saved.map(r => r.membership.id), ...companiesSaved.memberships];
      await observer!.query('DELETE FROM public.invitation_companies WHERE organization_id = ANY($1::uuid[])', [orgIds]);
      await observer!.query('DELETE FROM public.invitations WHERE organization_id = ANY($1::uuid[])', [orgIds]);
      await observer!.query('DELETE FROM public.user_sessions WHERE user_id = ANY($1::uuid[])', [users]);
      await observer!.query('DELETE FROM public.company_accesses WHERE membership_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])', [memberships, companiesSaved.companies]);
      await observer!.query('DELETE FROM public.companies WHERE id = ANY($1::uuid[])', [companiesSaved.companies]);
      await observer!.query('DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[])', [memberships]);
      await observer!.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [users]);
      await observer!.query('DELETE FROM public.organizations WHERE id = ANY($1::uuid[])', [orgIds]);
      const { emails, organizationNames } = companiesTargets;
      await observer!.query(companiesCleanupSQL.invitationCompanies, [organizationNames]);
      await observer!.query(companiesCleanupSQL.invitations, [organizationNames]);
      await observer!.query(companiesCleanupSQL.sessions, [emails]);
      await observer!.query(companiesCleanupSQL.accesses, [emails, organizationNames]);
      await observer!.query(companiesCleanupSQL.companies, [organizationNames]);
      await observer!.query(companiesCleanupSQL.memberships, [emails, organizationNames]);
      await observer!.query(companiesCleanupSQL.users, [emails]);
      await observer!.query(companiesCleanupSQL.organizations, [organizationNames]);
      await empty();
    }
    async function cleanupCompaniesWrite(userIds: string[], orgIds: string[]): Promise<void> {
      gate.assertArmed();
      if (!companiesWriteTargets) throw new Error('companies-write requiere reservas');
      const users = [...userIds, ...companiesSaved.users], memberships = [...saved.map(r => r.membership.id), ...companiesSaved.memberships];
      try {
        await observer!.query('DELETE FROM public.invitation_companies WHERE organization_id = ANY($1::uuid[])', [orgIds]);
        await observer!.query('DELETE FROM public.invitations WHERE organization_id = ANY($1::uuid[])', [orgIds]);
        await observer!.query('DELETE FROM public.user_sessions WHERE user_id = ANY($1::uuid[])', [users]);
        await observer!.query('DELETE FROM public.company_accesses WHERE membership_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])', [memberships, companiesSaved.companies]);
        await observer!.query('DELETE FROM public.companies WHERE id = ANY($1::uuid[])', [companiesSaved.companies]);
        await observer!.query('DELETE FROM public.organization_memberships WHERE id = ANY($1::uuid[])', [memberships]);
        await observer!.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [users]);
        await observer!.query('DELETE FROM public.organizations WHERE id = ANY($1::uuid[])', [orgIds]);
      } finally {
        // Exact reservations also cover committed requests whose response was lost.
        const { emails, organizationNames } = companiesWriteTargets;
        await observer!.query(companiesWriteCleanupSQL.invitationCompanies, [organizationNames]);
        await observer!.query(companiesWriteCleanupSQL.invitations, [organizationNames]);
        await observer!.query(companiesWriteCleanupSQL.sessions, [emails]);
        await observer!.query(companiesWriteCleanupSQL.accesses, [emails, organizationNames]);
        await observer!.query(companiesWriteCleanupSQL.companies, [organizationNames]);
        await observer!.query(companiesWriteCleanupSQL.memberships, [emails, organizationNames]);
        await observer!.query(companiesWriteCleanupSQL.users, [emails]);
        await observer!.query(companiesWriteCleanupSQL.organizations, [organizationNames]);
        await empty();
      }
    }
    async function register(value: ReturnType<typeof input>, target = service): Promise<RegistrationResult> {
      gate.assertArmed(); const result = await target.register(value); saved.push(result); return result;
    }
    /**
     * Members phase: exact ids first (everything the application returned), children before parents, then the reserved addresses and
     * organization names. Runs from afterAll: it does NOT survive a forced termination of the process.
     */
    async function cleanupMembers(userIds: string[], orgIds: string[]): Promise<void> {
      gate.assertArmed();
      if (!membersTargets) throw new Error('members requiere reservas');
      const users = [...userIds, ...membersSaved.users], memberships = [...saved.map(r => r.membership.id), ...membersSaved.memberships];
      try {
        await observer!.query(invitationsCleanupByIdSQL.invitationCompanies, [membersSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.invitations, [membersSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.sessions, [users]);
        await observer!.query(invitationsCleanupByIdSQL.accesses, [memberships, membersSaved.companies]);
        await observer!.query(invitationsCleanupByIdSQL.companies, [membersSaved.companies, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.memberships, [memberships, users, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.users, [users]);
        await observer!.query(invitationsCleanupByIdSQL.organizations, [orgIds]);
      } finally {
        const { emails, organizationNames } = membersTargets;
        await observer!.query(invitationsCleanupSQL.invitationCompanies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.invitations, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.sessions, [emails]);
        await observer!.query(invitationsCleanupSQL.accesses, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.companies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.memberships, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.users, [emails]);
        await observer!.query(invitationsCleanupSQL.organizations, [organizationNames]);
        await empty();
      }
    }
    /**
     * Acceptance phase: exact ids first (users, memberships, companies, invitations the application returned, and the organizations of every
     * registration, the competing ones included), children before parents, then the reserved addresses and organization names, which cover
     * a committed request whose response was lost. Runs from afterAll: it does NOT survive a forced termination of the process.
     */
    async function cleanupAcceptance(userIds: string[], orgIds: string[]): Promise<void> {
      gate.assertArmed();
      if (!acceptanceTargets) throw new Error('acceptance requiere reservas');
      const users = [...userIds, ...acceptanceSaved.users], memberships = [...saved.map(r => r.membership.id), ...acceptanceSaved.memberships];
      try {
        await observer!.query(invitationsCleanupByIdSQL.invitationCompanies, [acceptanceSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.invitations, [acceptanceSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.sessions, [users]);
        await observer!.query(invitationsCleanupByIdSQL.accesses, [memberships, acceptanceSaved.companies]);
        await observer!.query(invitationsCleanupByIdSQL.companies, [acceptanceSaved.companies, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.memberships, [memberships, users, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.users, [users]);
        await observer!.query(invitationsCleanupByIdSQL.organizations, [orgIds]);
      } finally {
        const { emails, organizationNames } = acceptanceTargets;
        await observer!.query(invitationsCleanupSQL.invitationCompanies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.invitations, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.sessions, [emails]);
        await observer!.query(invitationsCleanupSQL.accesses, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.companies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.memberships, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.users, [emails]);
        await observer!.query(invitationsCleanupSQL.organizations, [organizationNames]);
        await empty();
      }
    }
    /**
     * Exact ids first (every id the application returned or the observer seeded), children before parents, then the exact markers as a
     * backup for committed requests whose response was lost. It runs from afterAll: it does NOT survive a forced termination of the
     * process (SIGKILL, power loss); leftovers then show up as non-empty tables in the next run's baseline.
     */
    async function cleanupInvitations(userIds: string[], orgIds: string[]): Promise<void> {
      gate.assertArmed();
      if (!invitationsTargets) throw new Error('invitations requiere reservas');
      const users = [...userIds, ...invitationsSaved.users], memberships = [...saved.map(r => r.membership.id), ...invitationsSaved.memberships];
      try {
        await observer!.query(invitationsCleanupByIdSQL.invitationCompanies, [invitationsSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.invitations, [invitationsSaved.invitations, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.sessions, [users]);
        await observer!.query(invitationsCleanupByIdSQL.accesses, [memberships, invitationsSaved.companies]);
        await observer!.query(invitationsCleanupByIdSQL.companies, [invitationsSaved.companies, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.memberships, [memberships, users, orgIds]);
        await observer!.query(invitationsCleanupByIdSQL.users, [users]);
        await observer!.query(invitationsCleanupByIdSQL.organizations, [orgIds]);
      } finally {
        const { emails, organizationNames } = invitationsTargets;
        await observer!.query(invitationsCleanupSQL.invitationCompanies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.invitations, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.sessions, [emails]);
        await observer!.query(invitationsCleanupSQL.accesses, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.companies, [organizationNames]);
        await observer!.query(invitationsCleanupSQL.memberships, [emails, organizationNames]);
        await observer!.query(invitationsCleanupSQL.users, [emails]);
        await observer!.query(invitationsCleanupSQL.organizations, [organizationNames]);
        await empty();
      }
    }
    /** Backends of THIS run's application pool (the harness assumes it is the only application connected to agenda_test). */
    async function appPids(): Promise<number[]> {
      const rows: { pid: number }[] = await observer!.query(invitationsSQL.appSessions);
      return rows.map(r => r.pid).filter(pid => !beforePids.has(pid));
    }
    async function captureSessions(): Promise<void> {
      const sessions: Session[] = await observer!.query(sessionSQL);
      ownSessions = sessions.filter(s => !beforePids.has(s.pid));
      console.info(`[b2b] runId=${id} sesiones=${JSON.stringify(ownSessions)}`);
    }
    async function close(): Promise<void> {
      try {
        if (observer?.isInitialized && moduleRef) await captureSessions();
      } finally {
        try { if (app) await app.close(); else if (moduleRef) await moduleRef.close(); }
        finally {
          if (locker?.isInitialized) await locker.destroy();
          if (observer?.isInitialized) {
            try {
              const deadline = Date.now() + 5000;
              let remaining: Session[] = [];
              do {
                const sessions: Session[] = await observer.query(sessionSQL);
                remaining = sessions.filter(s => ownSessions.some(o => o.pid === s.pid && String(o.backend_start) === String(s.backend_start)));
                if (!remaining.length) break;
                await new Promise(resolve => setTimeout(resolve, 100));
              } while (Date.now() < deadline);
              expect(remaining).toEqual([]);
            } finally { await observer.destroy(); }
          }
        }
      }
    }
    beforeAll(async () => {
      console.info(`[b2b] runId=${id} phase=${phase}`);
      process.env.DATABASE_POOL_MAX ??= '10';
      const database = validateDatabaseEnvironment({ ...process.env }, { nodeEnv: 'test', role: 'app' });
      if (process.env.DATABASE_PORT !== '5433' || process.env.DATABASE_NAME !== 'agenda_test') throw new Error('Se exige DATABASE_PORT=5433 y DATABASE_NAME=agenda_test exactos');
      if (database.poolMax !== 10) throw new Error('Se exige pool 10 para las sondas concurrentes');
      const options = createDataSourceOptions(database, { logger });
      observer = new DataSource({ ...options, entities: [], extra: { ...options.extra, max: 1, application_name: `agenda-b2b-${id}` } });
      try {
        await observer.initialize();
        if (phase === 'invitations' || phase === 'acceptance') {
          logCapture.reset();
          // A second connection that only holds locks (the observer has a single connection and keeps polling).
          locker = new DataSource({ ...options, entities: [], extra: { ...options.extra, max: 1, application_name: `agenda-b2b-${id}-lock` } });
          await locker.initialize();
        }
        if (phase === 'members') {
          logCapture.reset();
          locker = new DataSource({ ...options, entities: [], extra: { ...options.extra, max: 1, application_name: `agenda-b2b-${id}-lock` } });
          await locker.initialize();
        }
        if (phase === 'readonly') {
          const rows: { ro: string; dro: string }[] = await observer.query(roSQL);
          expect(rows[0]).toMatchObject({ ro: 'on', dro: 'on' });
        }
        const rows: unknown[] = await observer.query(identitySQL);
        expect(rows).toHaveLength(1);
        expect(evaluateDatabaseIdentity(rows[0], { user: 'agenda_test_app', database: 'agenda_test' })).toBe(true);
        gate.mark('identity');
        const settings = await observer.query("SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS recovery, current_setting('server_encoding') AS encoding, d.datctype AS ctype, d.datcollate AS collate FROM pg_catalog.pg_database d WHERE d.datname = current_database()");
        expect(settings).toHaveLength(1);
        console.info('[b2b] configuración servidor', settings);
        expect(settings[0].version).toMatch(/^16\./); expect(settings[0].recovery).toBe(false); expect(settings[0].encoding).toBe('UTF8');
        for (const table of [...tables, 'schema_migrations']) {
          const found = await observer.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
          expect(found[0].relation).not.toBeNull();
        }
        // Structural checks are independent of SELECT on schema_migrations.
        const fingerprint = await observer.query(fingerprintSQL, [tables]);
        console.info('[b2b] huella negocio (referencia 82/80/33)', fingerprint);
        assertFingerprint('negocio', fingerprint[0], businessFingerprint);
        const migrations = await observer.query(fingerprintSQL, [['schema_migrations']]);
        console.info('[b2b] huella schema_migrations (referencia 3/1/1)', migrations);
        assertFingerprint('schema_migrations', migrations[0], migrationFingerprint);
        if (phase === 'auth' || phase === 'companies-write' || phase === 'invitations' || phase === 'acceptance') {
          const roles: { pg_get_constraintdef: string }[] = await observer.query("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'CK_organization_memberships_role'");
          expect(roles.length === 1 && roles[0].pg_get_constraintdef.includes("'worker'")).toBe(true);
        }
        gate.mark('schema');
        // Only a pg permission error from this history query may be tolerated.
        let historyResult: { rows: unknown[] } | { error: unknown };
        try {
          historyResult = { rows: await observer.query(migrationHistorySQL) };
        } catch (error) { historyResult = { error }; }
        migrationHistory = classifyMigrationHistory(historyResult, expectedMigrations);
        if (migrationHistory === 'unverified') console.warn('[b2b] historial de migraciones SIN VERIFICAR (sin SELECT sobre schema_migrations)');
        await empty(); gate.mark('baseline');
        beforePids = new Set((await observer.query(sessionSQL) as Session[]).map(s => s.pid));
        const { AppModule } = await import('../../../src/app.module');
        clock = new ControlledClock();
        if (phase === 'companies-write') {
          moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock).compile();
        } else if (phase === 'invitations') {
          // Real logger options (serializers, redaction, level from LOG_LEVEL): only the destination is replaced by an in-memory capture.
          moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock)
            .overrideModule(LoggingModule).useModule(CapturingLoggingModule).compile();
        } else if (phase === 'acceptance') {
          // Same as invitations: controlled clock and the real logger with an in-memory destination.
          moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock)
            .overrideModule(LoggingModule).useModule(CapturingLoggingModule).compile();
        } else if (phase === 'members') {
          // Controlled clock and the real logger with an in-memory destination.
          moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock)
            .overrideModule(LoggingModule).useModule(CapturingLoggingModule).compile();
        } else {
          // Preserve the existing auth/companies construction and its offline contract.
        moduleRef = phase === 'auth'
          ? await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock).compile()
          : await Test.createTestingModule({ imports: [AppModule] }).compile();
        }
        app = moduleRef.createNestApplication(); await configureHttpApp(app); await app.init();
        source = app.get(DataSource);
        if (phase === 'readonly') {
          // Hold five different physical connections concurrently, including verification before other assertions.
          const runners = Array.from({ length: 5 }, () => source.createQueryRunner());
          try {
            await Promise.all(runners.map(r => r.connect()));
            const readings = await Promise.all(runners.map(r => r.query(roSQL)));
            expect(new Set(readings.map(r => r[0].pid)).size).toBe(5);
            for (const reading of readings) expect(reading[0]).toMatchObject({ ro: 'on', dro: 'on' });
          } finally { await Promise.all(runners.map(r => r.release())); }
        }
        await captureSessions();
        expect(source.isInitialized).toBe(true); service = app.get(RegistrationService); expect(service).toBeInstanceOf(RegistrationService);
        expect(app.get(ConstraintRegistry).size).toBe(17);
        expect(new Set(source.entityMetadatas.map(m => m.target))).toEqual(new Set([User, Organization, OrganizationMembership, UserSession, Company, CompanyAccess]));
        ready = true;
        console.info(`[b2b] preflight completado: migrationHistory=${migrationHistory}`);
      } catch (error) { await close(); throw error; }
    });
    if (phase === 'dml' || phase === 'http') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else if (phase === 'auth' || phase === 'companies') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else if (phase === 'companies-write') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else if (phase === 'invitations') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else if (phase === 'acceptance') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else if (phase === 'members') {
      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });
    } else {
      afterAll(close); // readonly never registers a cleanup hook.
    }
    test('preflight y AppModule reales', () => expect(ready).toBe(true));
    if (phase === 'companies-write') registerCompaniesWriteTest(() => ({ app: app!, observer: observer!, clock, gate, saved, seeded: companiesSaved, reservations: companiesWriteReservations!, ready }));
    if (phase === 'invitations') registerInvitationsTest(() => ({ app: app!, source, observer: observer!, locker: locker!, clock, gate, saved, seeded: invitationsSaved,
      reservations: invitationsReservations!, id, zone: zone!, appPids, logs: logCapture, ready }));
    if (phase === 'acceptance') registerAcceptanceTest(() => ({ app: app!, source, observer: observer!, locker: locker!, clock, gate, saved, seeded: acceptanceSaved,
      reservations: acceptanceReservations!, id, zone: acceptanceZone!, appPids, logs: logCapture, ready }));
    if (phase === 'members') registerMembersTest(() => ({ app: app!, source, observer: observer!, locker: locker!, clock, gate, saved, seeded: membersSaved,
      reservations: membersReservations!, id, zone: membersZone!, appPids, logs: logCapture, ready }));
    if (phase === 'companies') registerCompaniesTest(() => ({ app: app!, observer: observer!, gate, saved, seeded: companiesSaved, reservations: companiesReservations!, ready }));
    if (phase === 'auth') registerAuthTest(() => ({ app: app!, observer: observer!, source, clock, gate, saved, id, ready }));
    if (phase === 'http') registerHttpTest(() => ({ app: app!, observer: observer!, gate, saved, id, ready, counts, credentials: input('http') }));
    if (phase === 'dml') {
      test('registro, rollback, concurrencia y equivalencia Unicode', async () => {
        expect(ready).toBe(true);
        gate.arm(); // Immediately before the first write, after all preflights succeeded.
        try {
          const firstInput = input('success'), first = await register(firstInput);
          for (const row of [first.user, first.organization, first.membership]) expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          expect((await counts()).slice(0, 3)).toEqual([1, 1, 1]);
          const joined = await observer!.query(`SELECT m.role, m.deactivated_at, u.version AS uv, o.version AS ov, m.version AS mv,
            u.created_at = u.updated_at AND u.created_at = o.created_at AND o.created_at = o.updated_at AND o.created_at = m.created_at AND m.created_at = m.updated_at AS dates,
            password_hash LIKE '$argon2id$%' AND char_length(password_hash) BETWEEN 40 AND 512 AS hash_ok
            FROM public.users u JOIN public.organization_memberships m ON m.user_id = u.id JOIN public.organizations o ON o.id = m.organization_id
            WHERE u.id = $1 AND o.id = $2 AND m.id = $3`, [first.user.id, first.organization.id, first.membership.id]);
          expect(joined).toEqual([{ role: 'community_manager', deactivated_at: null, uv: 1, ov: 1, mv: 1, dates: true, hash_ok: true }]);
          const duplicate = { ...input(), organizationName: firstInput.organizationName };
          await expect(register(duplicate)).rejects.toBeInstanceOf(ConflictError);
          await expect(register(duplicate)).rejects.toMatchObject({ field: 'organizationName' });
          expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [duplicate.email])).toEqual([]);
          const synthetic = new Error('B2B synthetic membership failure'); let inserts = 0;
          class FailingRunner extends DataSourceTransactionRunner {
            override run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
              return super.run(manager => work(new Proxy(manager, { get(target, property) {
                if (property === 'insert') return async (...args: Parameters<EntityManager['insert']>) => {
                  if (args[0] === OrganizationMembership) { expect(inserts).toBe(2); throw synthetic; }
                  const result = await target.insert(...args); inserts++; return result;
                };
                const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
              } })));
            }
          }
          const failingService = new RegistrationService(app!.get(PasswordHasher), app!.get(IdGenerator), new FailingRunner(source), app!.get(REGISTRATION_NOW), app!.get(REGISTRATION_NORMALIZERS));
          const forced = input('forced'); await expect(register(forced, failingService)).rejects.toBe(synthetic);
          expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [forced.email])).toEqual([]);
          expect(await observer!.query('SELECT id FROM public.organizations WHERE name = $1', [forced.organizationName])).toEqual([]);
          for (const c of normalizerRejected) {
            const initial = await counts(), runner = app!.get<TransactionRunner>(TransactionRunner), spy = jest.spyOn(runner, 'run');
            try {
              await expect(register({ ...input(), [c.field]: c.input })).rejects.toBeInstanceOf(InvalidInputError);
              await expect(register({ ...input(), [c.field]: c.input })).rejects.toMatchObject({ field: c.field });
              expect(spy).not.toHaveBeenCalled(); expect(await counts()).toEqual(initial);
            } finally { spy.mockRestore(); }
          }
          const started = Date.now();
          for (let round = 0; round < 5; round++) {
            for (const mode of ['email', 'organizationName', 'cross'] as const) {
              const before = await counts(), seed = sequence;
              const batch = Array.from({ length: mode === 'cross' ? 4 : 8 }, (_, index) => {
                const value = input(`round-${round}-${mode}-${index}`);
                if (mode === 'email') value.email = markers(id, seed, 'unused').email;
                if (mode === 'organizationName') value.organizationName = markers(id, seed, `round-${round}-fold-${index % 2 ? 'CAFE' : 'Café'}`).organizationName;
                if (mode === 'cross') {
                  value.email = markers(id, seed + (index % 2), 'unused').email;
                  value.organizationName = markers(id, seed, `cross-${round}-${Math.floor(index / 2)}`).organizationName;
                }
                return value;
              });
              const outcomes = await Promise.allSettled(batch.map(value => register(value)));
              const wins = outcomes.filter(o => o.status === 'fulfilled');
              if (mode !== 'cross') expect(wins).toHaveLength(1); else expect(wins.length).toBeGreaterThan(0);
              for (let i = 0; i < outcomes.length; i++) {
                const outcome = outcomes[i];
                if (outcome.status === 'rejected') {
                  const error: unknown = outcome.reason;
                  expect(['40P01', '55P03']).not.toContain(failure(error)?.sqlState);
                  expect(error).toBeInstanceOf(ConflictError);
                  if (mode !== 'cross') expect(error).toMatchObject({ field: mode });
                  if (mode === 'email') expect(await observer!.query('SELECT id FROM public.organizations WHERE name = $1', [batch[i].organizationName])).toEqual([]);
                  if (mode === 'organizationName') expect(await observer!.query('SELECT id FROM public.users WHERE email = $1', [batch[i].email])).toEqual([]);
                } else {
                  const r = outcome.value;
                  expect(await observer!.query('SELECT id FROM public.organization_memberships WHERE id = $1 AND user_id = $2 AND organization_id = $3', [r.membership.id, r.user.id, r.organization.id])).toHaveLength(1);
                }
              }
              const after = await counts(); expect(after.slice(0, 3).map((n, i) => n - before[i])).toEqual([wins.length, wins.length, wins.length]);
            }
          }
          expect(Date.now() - started).toBeLessThan(120000);
          for (const c of collisions) {
            const a = input(`collision-${c.id}-${c.first}`), b = input(`collision-${c.id}-${c.second}`);
            await register(a); await expect(register(b)).rejects.toBeInstanceOf(ConflictError);
            await expect(register(b)).rejects.toMatchObject({ field: 'organizationName' });
            await probe(async query => {
              await expect(query('INSERT INTO public.organizations (id,name,name_key,version,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())',
                [app!.get(IdGenerator).next(), normalizePersonName(b.organizationName), organizationNameKey(b.organizationName)])).rejects.toMatchObject({ driverError: { code: '23505', constraint: 'UQ_organizations_name_key' } });
            });
          }
          for (const c of distinct) {
            const a = input(`distinct-${c.id}-${c.first}`), b = input(`distinct-${c.id}-${c.second}`);
            expect(organizationNameKey(a.organizationName)).not.toBe(organizationNameKey(b.organizationName));
            await register(a); await register(b);
          }
          const phc = await app!.get(PasswordHasher).hash('B2b-test-only-long-passphrase-2026!');
          await probe(async query => {
            // Collect all case results so a CHECK mismatch does not hide the rest of the corpus.
            const actual: unknown[] = [], expected: unknown[] = [];
            for (const c of [...checkRejected, ...columnTypeRejected, ...accepted, { id: 'nbsp', input: 'Acme\u00a0Team', expected: 'accepted', reason: 'NBSP es aceptado sin normalizar por PostgreSQL' }]) {
              await query('SAVEPOINT unicode_case');
              try {
                let error: unknown;
                const name = c.expected === 'accepted' && c.id !== 'nbsp' ? normalizePersonName(c.input)! : 'Acme Team';
                try {
                  if ('column' in c && (c.column === 'email' || c.column === 'password_hash')) {
                    await query('INSERT INTO public.users (id,email,name,password_hash,password_changed_at,version,created_at,updated_at) VALUES ($1,$2,$3,$4,now(),1,now(),now())',
                      [app!.get(IdGenerator).next(), c.column === 'email' ? c.input : normalizeEmail(input().email), normalizePersonName('B2B Tester'), c.column === 'password_hash' ? c.input : phc]);
                  } else {
                    const rawName = 'column' in c && c.column === 'name' || c.id === 'nbsp' ? c.input : name;
                    const key = 'column' in c && c.column === 'name_key' ? c.input : organizationNameKey(name);
                    await query('INSERT INTO public.organizations (id,name,name_key,version,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())', [app!.get(IdGenerator).next(), rawName, key]);
                  }
                } catch (caught) { error = caught; }
                if ('constraint' in c) {
                  actual.push({ case: c.id, sqlState: failure(error)?.sqlState, constraint: failure(error)?.constraint });
                  expected.push({ case: c.id, sqlState: c.expected, constraint: c.constraint });
                } else if (c.expected === '22001') {
                  const classified = failure(error);
                  actual.push({ case: c.id, category: classified?.category, sqlState: classified?.sqlState, constraint: classified?.constraint });
                  expected.push({ case: c.id, category: 'data_exception', sqlState: c.expected, constraint: undefined });
                } else {
                  actual.push({ case: c.id, failure: failure(error), succeeded: error === undefined });
                  expected.push({ case: c.id, failure: undefined, succeeded: true });
                }
                if (c.id === 'nbsp' && error === undefined) console.info('[b2b] NBSP sin normalizar aceptado por PostgreSQL');
              } finally { await query('ROLLBACK TO SAVEPOINT unicode_case'); await query('RELEASE SAVEPOINT unicode_case'); }
            }
            expect(actual).toEqual(expected);
          });
        } finally { await cleanup(); }
      }, 240000);
    }
    async function probe(work: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<void>): Promise<void> {
      gate.assertArmed(); const runner = source.createQueryRunner();
      try { await runner.connect(); await runner.startTransaction(); await work((sql, values) => runner.query(sql, values)); }
      finally { try { if (runner.isTransactionActive) await runner.rollbackTransaction(); } finally { await runner.release(); } }
    }
  });
}
