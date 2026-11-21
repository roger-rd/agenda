import { SCHEMA_MANIFEST } from '../../../src/database/migrations/schema-manifest';

export const expectedMigrations = SCHEMA_MANIFEST.map(({ name, timestamp }) => ({ name, timestamp }));
export const migrationHistorySQL = 'SELECT id, name, timestamp FROM public.schema_migrations ORDER BY id';

export type MigrationHistory = 'verified' | 'unverified';

// The observer's TypeORM QueryFailedError retains the pg error in driverError.
// Inspect its shape without importing pg/TypeORM into the offline suite.
export function classifyMigrationHistory(result: { rows: readonly unknown[] } | { error: unknown }, expected: readonly { name: string; timestamp: number }[]): MigrationHistory {
  if ('rows' in result) {
    const timestampOf = (value: unknown): bigint | null => {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
      if (typeof value === 'string' && /^[0-9]{1,19}$/.test(value)) return BigInt(value);
      return null;
    };
    if (!Array.isArray(result.rows) || result.rows.length !== expected.length || !result.rows.every((row, i) => {
      if (!row || typeof row !== 'object') return false;
      const value = row as Record<string, unknown>;
      return value.name === expected[i].name && timestampOf(value.timestamp) !== null && timestampOf(value.timestamp) === timestampOf(expected[i].timestamp);
    })) throw new Error('El historial de migraciones no coincide con el manifiesto');
    return 'verified';
  }
  const error = result.error;
  const driver: unknown = error instanceof Error && error.name === 'QueryFailedError' && 'driverError' in error
    ? error.driverError : error;
  if (driver instanceof Error && 'code' in driver && driver.code === '42501' &&
    'severity' in driver && driver.severity === 'ERROR' && 'routine' in driver && typeof driver.routine === 'string') return 'unverified';
  throw error;
}
