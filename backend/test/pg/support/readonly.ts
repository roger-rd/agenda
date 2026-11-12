/**
 * TypeORM 1.1.2 PostgresDriver.connect/createPool and PostgresQueryRunner.getVersion:
 * SELECT version(), SELECT * FROM current_database(), SELECT * FROM current_schema().
 * SHOW server_version is also allowed. afterConnect only installs extensions when
 * metadata needs them: our three entities have PrimaryColumn uuid, no generated uuid,
 * citext/hstore/spatial/cube/ltree/vector/exclusions/custom extensions. No extension SQL.
 * pg 8.23.1 connection-parameters.js:83 uses val('options', config); val reads
 * process.env['PG' + key.toUpperCase()] if config has no value. Production extra has
 * max/application_name/connectionTimeoutMillis/idleTimeoutMillis, no options.
 * Deliberately conservative lexical guard: comments/quoted identifiers/dollar quoting
 * and unknown functions fail closed. The server read-only default is a separate layer.
 */
const functions = new Set(['version', 'current_database', 'current_schema', 'current_setting',
  'pg_is_in_recovery', 'has_schema_privilege', 'has_database_privilege', 'count', 'unnest',
  'to_regclass', 'pg_sleep', 'pg_backend_pid', 'char_length', 'lower', 'btrim', 'coalesce', 'any', 'select']);
export function assertReadonlyQuery(query: unknown): void {
  const text = typeof query === 'string' ? query : query && typeof query === 'object' ? Reflect.get(query, 'text') : undefined;
  if (typeof text !== 'string') throw new Error('readonly: consulta sin texto verificable');
  const sql = text.trim().replace(/;$/, '').trim();
  const deny = () => { throw new Error('readonly: consulta fuera de la lista blanca'); };
  if (/[;"\\]|--|\/\*|\*\/|\$[A-Za-z_]*\$/.test(sql)) deny();
  if (/^(?:BEGIN(?: READ ONLY)?|START TRANSACTION READ ONLY|COMMIT|ROLLBACK)$/i.test(sql)) return;
  if (/^SHOW\s+[a-z_]+$/i.test(sql)) return;
  if (!/^SELECT\s/i.test(sql)) deny();
  // Strip ordinary SQL string literals before checking tokens/functions. Reject unbalanced quotes.
  const code = sql.replace(/'(?:[^']|'')*'/g, ' ');
  if (/[^\x20-\x7e\s]/.test(code)) deny();
  if (code.includes("'") || /\b(?:into|insert|update|delete|create|alter|drop|truncate|copy|call|do|set|with|for)\b/i.test(code)) deny();
  for (const match of code.matchAll(/([\w.]+)\s*\(/g)) {
    if (!functions.has(match[1].toLowerCase())) deny();
  }
}
export function guardedQuery(original: (this: unknown, ...args: unknown[]) => unknown) {
  return function (this: unknown, ...args: unknown[]): unknown {
    assertReadonlyQuery(args[0]); // Synchronous throw is fail-closed also for callbacks and Query instances.
    return original.apply(this, args);
  };
}
