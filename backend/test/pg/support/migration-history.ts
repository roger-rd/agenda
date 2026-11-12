export type MigrationHistory = 'verified' | 'unverified';

// The observer's TypeORM QueryFailedError retains the pg error in driverError.
// Inspect its shape without importing pg/TypeORM into the offline suite.
export function classifyMigrationHistory(result: { rows: readonly unknown[] } | { error: unknown }): MigrationHistory {
  if ('rows' in result) {
    if (result.rows.length !== 1) throw new Error('Se exige exactamente 1 fila en el historial de migraciones');
    return 'verified';
  }
  const error = result.error;
  const driver: unknown = error instanceof Error && error.name === 'QueryFailedError' && 'driverError' in error
    ? error.driverError : error;
  if (driver instanceof Error && 'code' in driver && driver.code === '42501' &&
    'severity' in driver && driver.severity === 'ERROR' && 'routine' in driver && typeof driver.routine === 'string') return 'unverified';
  throw error;
}
