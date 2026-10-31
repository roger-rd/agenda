'use strict';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, PRECONDITION: 2, CLEANUP: 3, INTEGRITY: 4, SIGINT: 130, SIGTERM: 143 });
const TIMINGS = Object.freeze({ graceMs: 10000, postKillWaitMs: 2000, watchdogMs: 1200000, tokenTtlSeconds: 1500, tokenFutureSkewSeconds: 5 });
const ENV_FILES = Object.freeze({ app: '.env.test', owner: '.env.test.migration' });
const ENV_LIMITS = Object.freeze({ maxBytes: 8192, maxLines: 64 });
const KNOWN_ENV_KEYS = Object.freeze(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_POOL_MAX']);
const CHILD_ENV_KEYS = Object.freeze(['NODE_ENV', 'AGENDA_DB_TEST_TOKEN', 'PGPASSFILE', 'NO_COLOR', 'TMPDIR']);
const MODES = Object.freeze(['fast', 'slow']);
const SUMMARY_STATUSES = Object.freeze(['not_ready', 'ok', 'failed', 'aborted', 'error']);
const SUMMARY_PHASES = Object.freeze(['args', 'platform', 'package', 'c8-gate', 'env', 'preflight', 'run', 'cleanup', 'internal']);

// Evita que el import de namespace genere un envoltorio mutable sobre el contrato.
module.exports = Object.freeze(Object.defineProperty({ EXIT, TIMINGS, ENV_FILES, ENV_LIMITS, KNOWN_ENV_KEYS, CHILD_ENV_KEYS,
  PGPASSFILE_INERT: '/nonexistent/.agenda-no-pgpass', SUMMARY_PREFIX: 'AGENDA_TEST_DB_SUMMARY ',
  PACKAGE_NAME: 'agenda-contenido-backend', MIN_SECRET_BYTES: 8, MODES, SUMMARY_STATUSES, SUMMARY_PHASES }, '__esModule', { value: true }));
