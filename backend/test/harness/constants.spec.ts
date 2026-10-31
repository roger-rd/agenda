import * as constants from '../../scripts/harness/constants.cjs';

describe('constants B1', () => {
  it('fija valores exactos del contrato', () => {
    expect(constants.EXIT).toEqual({ OK: 0, FAILED: 1, PRECONDITION: 2, CLEANUP: 3, INTEGRITY: 4, SIGINT: 130, SIGTERM: 143 });
    expect(constants.TIMINGS).toEqual({ graceMs: 10000, postKillWaitMs: 2000, watchdogMs: 1200000, tokenTtlSeconds: 1500, tokenFutureSkewSeconds: 5 });
    expect(constants.ENV_FILES).toEqual({ app: '.env.test', owner: '.env.test.migration' });
    expect(constants.ENV_LIMITS).toEqual({ maxBytes: 8192, maxLines: 64 });
    expect(constants.KNOWN_ENV_KEYS).toEqual(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_POOL_MAX']);
    expect(constants.CHILD_ENV_KEYS).toEqual(['NODE_ENV', 'AGENDA_DB_TEST_TOKEN', 'PGPASSFILE', 'NO_COLOR', 'TMPDIR']);
    expect(constants.PGPASSFILE_INERT).toBe('/nonexistent/.agenda-no-pgpass');
    expect(constants.SUMMARY_PREFIX).toBe('AGENDA_TEST_DB_SUMMARY ');
    expect(constants.PACKAGE_NAME).toBe('agenda-contenido-backend');
    expect(constants.MIN_SECRET_BYTES).toBe(8);
    expect(constants.MODES).toEqual(['fast', 'slow']);
    expect(constants.SUMMARY_STATUSES).toEqual(['not_ready', 'ok', 'failed', 'aborted', 'error']);
    expect(constants.SUMMARY_PHASES).toEqual(['args', 'platform', 'package', 'c8-gate', 'env', 'preflight', 'run', 'cleanup', 'internal']);
  });
  it('congela profundamente los objetos exportados', () => {
    function frozen(value: unknown) {
      if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(frozen);
      }
    }
    frozen(constants);
  });
  it('mantiene márgenes temporales coherentes', () => {
    const t = constants.TIMINGS;
    expect(t.watchdogMs).toBeLessThan(t.tokenTtlSeconds * 1000);
    expect(t.graceMs).toBeGreaterThan(t.postKillWaitMs);
    expect(t.postKillWaitMs).toBeGreaterThan(0);
    expect(t.watchdogMs + t.graceMs + t.postKillWaitMs).toBeLessThan(t.tokenTtlSeconds * 1000);
  });
});
