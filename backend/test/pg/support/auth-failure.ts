// Keep this module free of database imports so diagnostics can be tested offline.
export function formatAuthFailure(step: string, error: unknown): string {
  const name = error instanceof Error ? error.constructor.name || error.name : 'UnknownError';
  const driver: unknown = error instanceof Error && error.name === 'QueryFailedError' && 'driverError' in error
    ? error.driverError : error;
  const isDatabaseError = error instanceof Error && (error.name === 'QueryFailedError' ||
    (driver instanceof Error && 'severity' in driver && 'routine' in driver));
  const code = isDatabaseError && driver instanceof Error && 'code' in driver &&
    typeof driver.code === 'string' && /^[0-9A-Z]{5}$/.test(driver.code) ? driver.code : undefined;
  return `auth: escenario fallido en "${step}" (${name})${code ? ` SQLSTATE ${code}` : ''}`;
}
