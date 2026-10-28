import 'reflect-metadata';
import { loadMigrationEnvironment, migrationEnvFile } from './migration-environment';
import { Environment } from './env.validation';

const fake = { DATABASE_NAME: 'agenda_live', DATABASE_USER: 'agenda_live_owner', DATABASE_PASSWORD: 'fake-password-for-unit-tests-0001' };
const contents = (data: Record<string, string>) => Object.entries(data).map(([key, value]) => `${key}=${value}`).join('\n');
describe('Entorno de migraciones', () => {
  it.each([['development', '.env.migration'], ['test', '.env.test.migration'], ['production', undefined]] as const)('selecciona archivo en %s', (env, file) => expect(migrationEnvFile(env)).toBe(file));
  it.each(['development', 'test'] as Environment[])('solo lee el archivo en %s', nodeEnv => {
    const suffix = nodeEnv === 'test' ? 'test' : 'dev';
    const readFile = jest.fn(() => contents({ ...fake, DATABASE_NAME: `agenda_${suffix}`, DATABASE_USER: `agenda_${suffix}_owner` }));
    const config = loadMigrationEnvironment({ nodeEnv, cwd: '/ficticio', env: { DATABASE_USER: 'CANARIO_SECRETO_123', DATABASE_PORT: 'invalid', DATABASE_HOST: 'remote' }, readFile });
    expect(readFile).toHaveBeenCalledWith(`/ficticio/${migrationEnvFile(nodeEnv)}`);
    expect(config.credentials.user).toBe(`agenda_${suffix}_owner`);
    expect(config.port).toBe(5433);
  });
  it('usa solo env en producción', () => {
    const readFile = jest.fn(() => { throw new Error('No leer'); });
    expect(loadMigrationEnvironment({ nodeEnv: 'production', env: fake, readFile }).name).toBe('agenda_live');
    expect(readFile).not.toHaveBeenCalled();
  });
  it('archivo ausente no expone la causa', () => {
    const readFile = () => { throw new Error('CANARIO_SECRETO_123'); };
    let message = '';
    try { loadMigrationEnvironment({ nodeEnv: 'test', readFile }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('.env.test.migration');
    expect(message).not.toContain('CANARIO_SECRETO_123');
  });
  it('no completa archivo incompleto con variables de proceso', () => {
    expect(() => loadMigrationEnvironment({ nodeEnv: 'test', env: fake, readFile: () => '' })).toThrow('DATABASE_PASSWORD:');
  });
  it.each(['agenda_test_app', 'CANARIO_SECRETO_123'])('rechaza usuario inválido caso %#', DATABASE_USER => {
    let message = '';
    try { loadMigrationEnvironment({ nodeEnv: 'test', readFile: () => contents({ ...fake, DATABASE_NAME: 'agenda_test', DATABASE_USER }) }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('DATABASE_USER:');
    expect(message.includes(DATABASE_USER)).toBe(false);
  });
  it('rechaza formato inválido sin valores', () => {
    expect(() => loadMigrationEnvironment({ nodeEnv: 'test', readFile: () => 'DATABASE_PORT=CANARIO_SECRETO_123' })).toThrow('DATABASE_PORT:');
  });
});
