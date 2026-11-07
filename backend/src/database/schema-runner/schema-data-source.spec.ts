import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { DatabaseConnectionConfig, DatabaseCredentials } from '../../config/database-credentials';
import { assertSafeDataSourceOptions } from '../data-source-options';
import { SafeTypeOrmLogger } from '../safe-typeorm-logger';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { assertSafeSchemaDataSourceOptions, createSchemaDataSourceOptions, describeSchemaDataSource } from './schema-data-source';
import { SchemaRunnerError, type SchemaCommand } from './schema-target';

const password = 'fake-owner-password-for-unit-tests-0002';
const logger = new SafeTypeOrmLogger({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
const config = (host = '127.0.0.1', user = 'agenda_test_owner') => new DatabaseConnectionConfig(host, 5433, 'agenda_test', new DatabaseCredentials(user, password), 5);
const make = (mode: SchemaCommand = 'apply') => createSchemaDataSourceOptions(config(), mode, { logger });
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof SchemaRunnerError ? e.code : 'other'; } return null; };
const mutate = (patch: Record<string, unknown>) => ({ ...make(), ...patch }) as PostgresDataSourceOptions;

describe('DataSource protegido del runner de esquema', () => {
  it('construye exactamente las opciones aprobadas', () => {
    const options = make('apply');
    expect(options).toEqual({
      type: 'postgres', host: '127.0.0.1', port: 5433, database: 'agenda_test', username: 'agenda_test_owner', password, schema: 'public',
      entities: [], migrations: SCHEMA_MANIFEST.map(e => e.migration), migrationsTableName: 'schema_migrations', migrationsTransactionMode: 'all',
      synchronize: false, dropSchema: false, migrationsRun: false, installExtensions: false, ssl: false, logger, logging: ['error'],
      extra: { max: 1, application_name: 'agenda-schema-runner', connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000,
        idle_in_transaction_session_timeout: 30000, options: '-c default_transaction_read_only=off' },
    });
  });
  it('plan abre la sesión en solo lectura; apply y revert, de escritura', () => {
    expect(make('plan').extra).toMatchObject({ options: '-c default_transaction_read_only=on' });
    expect(make('apply').extra).toMatchObject({ options: '-c default_transaction_read_only=off' });
    expect(make('revert').extra).toMatchObject({ options: '-c default_transaction_read_only=off' });
  });
  it('un solo cliente y sin entidades: no registra la capa de persistencia', () => {
    const options = make();
    expect((options.extra as { max: number }).max).toBe(1);
    expect(options.entities).toEqual([]);
    expect(options.subscribers).toBeUndefined();
  });
  it('la contraseña solo aparece en el campo password y nunca en la descripción', () => {
    const options = make();
    expect(options.password).toBe(password);
    expect(describeSchemaDataSource(options)).toBe('agenda_test_owner@127.0.0.1:5433/agenda_test');
    expect(describeSchemaDataSource(options)).not.toContain(password);
    expect(JSON.stringify({ ...options, password: undefined, logger: undefined })).not.toContain(password);
  });
  it('acepta los tres anfitriones de loopback y rechaza cualquier otro, o el rol de aplicación', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(() => createSchemaDataSourceOptions(config(host), 'plan', { logger })).not.toThrow();
    expect(codeOf(() => createSchemaDataSourceOptions(config('db.example.com'), 'plan', { logger }))).toBe('target_mismatch');
    expect(codeOf(() => createSchemaDataSourceOptions(config('127.0.0.1', 'agenda_test_app'), 'plan', { logger }))).toBe('target_mismatch');
  });
  it('las opciones del runner no pasan la verificación de la aplicación y viceversa', () => {
    expect(() => assertSafeDataSourceOptions(make() as never)).toThrow();
    expect(codeOf(() => assertSafeSchemaDataSourceOptions({ type: 'postgres', host: '127.0.0.1', port: 5433, database: 'agenda_test', username: 'agenda_test_app', password,
      entities: [], migrations: [], synchronize: false, dropSchema: false, migrationsRun: false } as PostgresDataSourceOptions, 'apply'))).toBe('options_unsafe');
  });

  it.each([
    ['producción', { database: 'agenda' }], ['desarrollo', { database: 'agenda_dev' }], ['usuario de aplicación', { username: 'agenda_test_app' }],
    ['superusuario', { username: 'postgres' }], ['puerto', { port: 5432 }], ['host remoto', { host: '10.1.1.1' }], ['sin contraseña', { password: '' }],
    ['contraseña no texto', { password: 12345 }], ['esquema', { schema: 'other' }], ['entidades', { entities: [class Foo {}] }],
    ['sin migraciones', { migrations: [] }], ['migración extra', { migrations: [...SCHEMA_MANIFEST.map(e => e.migration), class Extra {}] }],
    ['patrón de migraciones', { migrations: ['dist/migrations/*.js'] }], ['tabla de migraciones', { migrationsTableName: 'migrations' }],
    ['modo de transacción each', { migrationsTransactionMode: 'each' }], ['modo de transacción none', { migrationsTransactionMode: 'none' }],
    ['synchronize', { synchronize: true }], ['synchronize ausente', { synchronize: undefined }], ['dropSchema', { dropSchema: true }],
    ['migrationsRun', { migrationsRun: true }], ['migrationsRun ausente', { migrationsRun: undefined }], ['instalar extensiones', { installExtensions: true }],
    ['extensiones por defecto', { installExtensions: undefined }], ['TLS activado', { ssl: true }], ['TLS con objeto', { ssl: { rejectUnauthorized: false } }],
    ['registro completo', { logging: true }], ['registro de consultas', { logging: ['error', 'query'] }], ['url', { url: 'postgres://u:p@h/db' }],
    ['clave desconocida', { subscribers: [] }], ['réplica', { replication: { master: {}, slaves: [] } }],
    ['extra ausente', { extra: undefined }], ['extra mayor', { extra: { max: 5, application_name: 'agenda-schema-runner' } }],
  ])('rechaza %s', (_name, patch) => { expect(codeOf(() => assertSafeSchemaDataSourceOptions(mutate(patch), 'apply'))).toBe('options_unsafe'); });

  it.each([
    ['más conexiones', { max: 2 }], ['sin tope de sentencia', { statement_timeout: 0 }], ['bloqueo largo', { lock_timeout: 60000 }],
    ['sin tiempo de espera inactivo', { idle_in_transaction_session_timeout: 0 }], ['nombre de aplicación', { application_name: 'psql' }],
    ['opciones de servidor extra', { options: '-c default_transaction_read_only=off -c search_path=evil' }], ['clave extra', { password: 'x' }],
    ['sin tiempo de conexión', { connectionTimeoutMillis: 0 }],
  ])('rechaza en extra: %s', (_name, patch) => {
    const options = make();
    expect(codeOf(() => assertSafeSchemaDataSourceOptions({ ...options, extra: { ...(options.extra as object), ...patch } } as PostgresDataSourceOptions, 'apply'))).toBe('options_unsafe');
  });
  it('el modo de solo lectura de la sesión debe corresponder a la orden', () => {
    expect(codeOf(() => assertSafeSchemaDataSourceOptions(make('plan'), 'apply'))).toBe('options_unsafe');
    expect(codeOf(() => assertSafeSchemaDataSourceOptions(make('apply'), 'plan'))).toBe('options_unsafe');
    expect(codeOf(() => assertSafeSchemaDataSourceOptions(make('plan'), 'plan'))).toBeNull();
  });
  it('no acepta valores que no son objeto', () => {
    expect(codeOf(() => assertSafeSchemaDataSourceOptions(null as never, 'plan'))).toBe('options_unsafe');
    expect(codeOf(() => assertSafeSchemaDataSourceOptions(undefined as never, 'plan'))).toBe('options_unsafe');
  });
});
