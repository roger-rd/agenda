type Fingerprint = { columns: number; constraints: number; indexes: number };

export const businessFingerprint: Readonly<Fingerprint> = { columns: 68, constraints: 64, indexes: 26 };
export const migrationFingerprint: Readonly<Fingerprint> = { columns: 3, constraints: 1, indexes: 1 };

export const fingerprintSQL = `SELECT
          (SELECT count(*)::int FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = ANY($1) AND t.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
          (SELECT count(*)::int FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = ANY($1)) AS constraints,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1)) AS indexes`;

export function assertFingerprint(label: string, received: Fingerprint | undefined, expected: Readonly<Fingerprint>): void {
  if (!received || received.columns !== expected.columns || received.constraints !== expected.constraints || received.indexes !== expected.indexes) {
    throw new Error(`[b2b] huella ${label} difiere: esperados=${JSON.stringify(expected)}; recibidos=${JSON.stringify(received)}`);
  }
}
