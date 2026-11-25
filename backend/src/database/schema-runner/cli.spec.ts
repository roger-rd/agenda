import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { withObservedDefinitions } from './testing/observed-initial-definitions';
import { derivePrefix, definitionsDigest, normalizeExpression } from './schema-structure';
import { DEFINITIONS_PREFIX, DRIFT_PREFIX, runCli, type CliDeps } from './cli';
import type { CredentialFs, FileFacts } from './credential-file';
import { confirmationFor } from './schema-guards';
import type { SchemaPort } from './schema-runner';
import * as SQL from './schema-sql';
import { BUDGET, EXIT, LOCK_KEY, SUMMARY_PREFIX, type SchemaCommand } from './schema-target';

const SECRET = 'fake-owner-password-for-unit-tests-0005';
const ENV_TEXT = ['DATABASE_HOST=127.0.0.1', 'DATABASE_PORT=5433', 'DATABASE_NAME=agenda_test', 'DATABASE_USER=agenda_test_owner', `DATABASE_PASSWORD=${SECRET}`].join('\n') + '\n';

function fakeFs(over: { mode?: number; text?: string } = {}) {
  const bytes = Buffer.from(over.text ?? ENV_TEXT, 'utf8'); const calls: string[] = [];
  const facts = (kind: 'file' | 'dir'): FileFacts => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', nlink: 1, uid: 501, mode: kind === 'file' ? (over.mode ?? 0o100600) : 0o040755, size: bytes.length });
  const fs: CredentialFs = {
    platform: 'darwin', uid: 501, flags: 1,
    open: () => { calls.push('open'); return 9; }, fstat: () => facts('file'), stat: () => facts('dir'), close: () => undefined,
    read: (_fd, buffer, offset, length, position) => { const n = Math.min(length, Math.max(0, bytes.length - position)); buffer.set(bytes.subarray(position, position + n), offset); return n; },
  };
  return { fs, calls };
}

/** A plan-capable port: answers only what a plan asks for. */
function planPort(over: { prefix?: 1 | 2; structure?: unknown; connectFails?: boolean; hang?: boolean; onConnect?: () => void; boom?: boolean } = {}) {
  const events: string[] = []; let tx = false; let closed = false;
  const entries = SCHEMA_MANIFEST.slice(0, over.prefix ?? 0);
  const tables = entries.flatMap(e => [...e.tables]);
  const port: SchemaPort = {
    async connect() { events.push('connect'); over.onConnect?.(); if (over.connectFails) throw Object.assign(new Error(SECRET), { code: '28P01' }); if (over.hang) await new Promise<never>(() => undefined); },
    async query(sql) {
      events.push(sql === SQL.LOCK_SQL ? 'lock' : sql === SQL.UNLOCK_SQL ? 'unlock' : 'query');
      switch (sql) {
        case SQL.LOCK_SQL: return [{ locked: true }]; case SQL.UNLOCK_SQL: return [{ unlocked: true }];
        case SQL.IDENTITY_SQL: return [{ database: 'agenda_test', current_user: 'agenda_test_owner', session_user: 'agenda_test_owner', version_num: 160015, in_recovery: false,
          transaction_read_only: 'on', default_read_only: 'on', standard_conforming_strings: 'on', current_schema: 'public', effective_search_path: 'public', statement_timeout: '15s',
          lock_timeout: '5s', idle_in_transaction_session_timeout: '30s', application_name: 'agenda-schema-runner', rolsuper: false, rolcreaterole: false, rolcreatedb: false,
          rolreplication: false, rolbypassrls: false, rolcanlogin: true, can_use_public: true, can_create_public: true, owns_database: true, event_triggers: 0, owner_memberships: 0, app_role_exists: true }];
        case SQL.RELATIONS_SQL: return over.prefix ? [...tables.map(name => ({ name, kind: 'r' })),
          { name: 'schema_migrations', kind: 'r' }, { name: 'schema_migrations_id_seq', kind: 'S' }] : [];
        case SQL.MIGRATIONS_COLUMNS_SQL: return [{ name: 'id', type: 'integer' }, { name: 'timestamp', type: 'bigint' }, { name: 'name', type: 'character varying' }];
        case SQL.EXECUTED_SQL: return entries.map(e => ({ name: e.name, timestamp: String(e.timestamp) }));
        case SQL.STRUCTURE_SQL: return 'structure' in over ? over.structure : withObservedDefinitions(derivePrefix(SCHEMA_MANIFEST, over.prefix!));
        case SQL.APPLICATION_PRIVILEGES_SQL: return tables.flatMap(name => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(privilege =>
          ({ name, privilege, effective: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), grantable: false })));
        case SQL.MIGRATIONS_PRIVILEGES_SQL: return [
          ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(privilege => ({ kind: 'table', privilege })),
          ...['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => ({ kind: 'column', privilege })),
          ...['USAGE', 'SELECT', 'UPDATE'].map(privilege => ({ kind: 'sequence', privilege })),
        ].map(r => ({ ...r, effective: false, grantable: false })); case SQL.FOREIGN_OBJECTS_SQL: return [{ routines: 0, types: 0, extensions: 0 }];
        case SQL.TRANSACTION_CLOSED_SQL: return [{ no_xid: !tx, no_backend_xid: !tx, implicit_transaction: !tx }];
        default: throw new Error(SECRET);
      }
    },
    async exec() { events.push('exec'); }, async begin() { events.push('begin'); tx = true; }, async commit() { events.push('commit'); tx = false; },
    async rollback() { events.push('rollback'); tx = false; }, async applyMigrations() { events.push('migrate'); return []; }, async revertLast() { events.push('revert'); },
    transactionEvidence() { return { clientStatus: tx ? 'T' : 'I', queryRunnerActive: tx }; }, async close() { events.push('close'); closed = true; }, isClosed() { return closed; },
  };
  return { port, events };
}

function deps(argv: string[], over: Partial<CliDeps> = {}) {
  const lines: string[] = []; const exits: number[] = [];
  const handlers = new Map<string, Set<() => void>>(); const timers = new Map<number, { fn: () => void; ms: number }>(); let seq = 0;
  const base: CliDeps = {
    argv, cwd: '/work', write: l => { lines.push(l); }, clock: () => 0, exit: c => { exits.push(c); },
    signals: { on: (n, fn) => { handlers.set(n, (handlers.get(n) ?? new Set()).add(fn)); }, off: (n, fn) => { handlers.get(n)?.delete(fn); } },
    timers: { set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clear: h => { timers.delete(h as number); } },
    fs: fakeFs().fs, openPort: () => planPort().port, ...over,
  };
  return { base, lines, exits, handlers, timers, emit: (n: string) => { for (const fn of [...(handlers.get(n) ?? [])]) fn(); } };
}
const args = (command: string, confirm?: string) => [command, '--env=test', '--target=agenda_test', `--confirm=${confirm ?? confirmationFor(command as SchemaCommand)}`];
const summary = (lines: string[]) => { expect(lines).toHaveLength(1); expect(lines[0].startsWith(SUMMARY_PREFIX)).toBe(true); expect(lines[0].endsWith('\n')).toBe(true); return JSON.parse(lines[0].slice(SUMMARY_PREFIX.length)) as Record<string, unknown>; };

describe('línea de órdenes del runner de esquema', () => {
  it('plan válido: una sola línea estructurada, salida 0, señales y temporizadores liberados', async () => {
    const d = deps(args('plan'));
    expect(await runCli(d.base)).toBe(EXIT.ok);
    expect(summary(d.lines)).toMatchObject({ command: 'plan', target: 'agenda_test', outcome: 'planned', ok: true, state: 'fresh', exit: 0, lock: 'released', closure: 'verified' });
    expect(d.timers.size).toBe(0);
    expect([...d.handlers.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(d.lines[0]).not.toContain(SECRET);
    expect(d.exits).toEqual([]);
  });
  it('registra SIGINT y SIGTERM y arma el límite duro de 90 s', async () => {
    const seen: string[] = []; const d = deps(args('plan'));
    const original = d.base.signals.on; d.base.signals.on = (n, fn) => { seen.push(n); return original(n, fn); };
    const setTimer = d.base.timers.set; const ms: number[] = []; d.base.timers.set = (fn, t) => { ms.push(t); return setTimer(fn, t); };
    await runCli(d.base);
    expect(seen.sort()).toEqual(['SIGINT', 'SIGTERM']); expect(ms[0]).toBe(BUDGET.hardExitMs);
  });

  describe('gramática cerrada y confirmaciones: se rechaza antes de leer credenciales o abrir nada', () => {
    it.each([
      ['sin argumentos', []], ['orden desconocida', args('migrate', 'x')], ['sin confirmación', ['plan', '--env=test', '--target=agenda_test']],
      ['confirmación de otra orden', args('apply', confirmationFor('plan'))], ['confirmación de revert para apply', args('apply', confirmationFor('revert'))],
      ['resumen de manifiesto erróneo', args('apply', 'APPLY:agenda_test:00000000')], ['producción', ['plan', '--env=production', '--target=agenda_test', '--confirm=PLAN:agenda_test']],
      ['desarrollo', ['plan', '--env=development', '--target=agenda_test', '--confirm=PLAN:agenda_test']], ['otra base', ['plan', '--env=test', '--target=agenda_dev', '--confirm=PLAN:agenda_test']],
      ['opción extra', [...args('plan'), '--force']], ['definiciones con apply', [...args('apply'), '--show-definitions']], ['deriva con apply', [...args('apply'), '--show-drift']], ['deriva con revert', [...args('revert'), '--show-drift']], ['deriva repetida', [...args('plan'), '--show-drift', '--show-drift']], ['opción repetida', [...args('plan'), '--env=test']], ['argumento suelto', [...args('plan'), 'x']],
    ])('%s', async (_name, argv) => {
      const f = fakeFs(); let opened = 0;
      const d = deps(argv as string[], { fs: f.fs, openPort: () => { opened++; return planPort().port; } });
      expect(await runCli(d.base)).toBe(EXIT.refused);
      const s = summary(d.lines);
      expect(s).toMatchObject({ outcome: 'refused', ok: false, exit: 2, target: 'agenda_test' });
      expect(['args_invalid', 'env_forbidden', 'target_invalid', 'confirmation_invalid']).toContain(s.code);
      expect(f.calls).toEqual([]); expect(opened).toBe(0);
    });
    it('con su propio token, apply y revert llegan a la sesión (aquí se detienen en la identidad, sin DDL)', async () => {
      for (const command of ['apply', 'revert']) {
        const f = planPort(); const d = deps(args(command), { openPort: () => f.port });
        expect(await runCli(d.base)).toBe(2);
        expect(summary(d.lines)).toMatchObject({ command, code: 'identity_read_only', lock: 'released' });
        expect(f.events.filter(e => /^(begin|migrate|revert|exec|commit)$/.test(e))).toEqual([]);
      }
    });
  });

  describe('credenciales', () => {
    it('archivo con permisos amplios: se rechaza con código y sin abrir sesión', async () => {
      let opened = 0; const d = deps(args('plan'), { fs: fakeFs({ mode: 0o100644 }).fs, openPort: () => { opened++; return planPort().port; } });
      expect(await runCli(d.base)).toBe(2);
      expect(summary(d.lines)).toMatchObject({ code: 'credential_file_unsafe', outcome: 'refused' }); expect(opened).toBe(0);
      expect(d.lines[0]).not.toContain(SECRET);
    });
    it('contenido que no es el del dueño de pruebas: se rechaza sin filtrar la contraseña', async () => {
      const d = deps(args('plan'), { fs: fakeFs({ text: ENV_TEXT.replace('agenda_test_owner', 'agenda_test_app') }).fs });
      expect(await runCli(d.base)).toBe(2);
      expect(['credential_invalid', 'target_mismatch']).toContain(summary(d.lines).code); expect(d.lines[0]).not.toContain(SECRET);
    });
  });

  describe('salidas diferenciadas y secretos', () => {
    it('fallo de conexión: salida 2, código cerrado, sin mensaje del driver', async () => {
      const d = deps(args('plan'), { openPort: () => planPort({ connectFails: true }).port });
      expect(await runCli(d.base)).toBe(2);
      expect(summary(d.lines)).toMatchObject({ code: 'connect_failed', sqlstate: '28P01', exit: 2 }); expect(d.lines[0]).not.toContain(SECRET);
    });
    it('error inesperado al abrir el puerto: internal_error sin detalles', async () => {
      const d = deps(args('plan'), { openPort: () => { throw new Error(SECRET); } });
      expect(await runCli(d.base)).toBe(2);
      expect(summary(d.lines)).toMatchObject({ code: 'internal_error', outcome: 'refused' }); expect(d.lines[0]).not.toContain(SECRET);
    });
    it('cierre no verificado: salida 3', async () => {
      const f = planPort(); f.port.isClosed = () => false;
      const d = deps(args('plan'), { openPort: () => f.port });
      expect(await runCli(d.base)).toBe(EXIT.unconfirmed);
      expect(summary(d.lines)).toMatchObject({ resources: 'unverified', closure: 'unverified', exit: 3 });
    });
    it('la salida tiene siempre la misma forma cerrada', async () => {
      const keys = new Set<string>();
      for (const open of [() => planPort().port, () => planPort({ connectFails: true }).port]) {
        const d = deps(args('plan'), { openPort: open }); await runCli(d.base); Object.keys(summary(d.lines)).forEach(k => keys.add(k));
      }
      const refused = deps([]); await runCli(refused.base); Object.keys(summary(refused.lines)).forEach(k => keys.add(k));
      expect([...keys].sort()).toEqual(['closure', 'code', 'command', 'committed', 'elapsedMs', 'executed', 'exit', 'findings', 'lock', 'ok', 'outcome', 'pending', 'resources', 'sqlstate', 'stage', 'state', 'structure', 'structureDigest', 'target', 'transaction']);
    });
  });

  describe('señales y límite duro', () => {
    it('una señal recibida antes de empezar a operar impide ejecutar nada y se informa', async () => {
      const f = planPort(); let emit: (n: string) => void = () => undefined;
      const d = deps(args('plan'), { openPort: () => { emit('SIGTERM'); return f.port; } }); emit = d.emit;
      expect(await runCli(d.base)).toBe(2);
      expect(summary(d.lines)).toMatchObject({ code: 'aborted_by_signal', ok: false }); expect(f.events).toEqual(['close']);
    });
    it('el límite duro de 90 s emite un resumen con salida 3, sale con 3 y no vuelve a emitir', async () => {
      const f = planPort({ hang: true }); const d = deps(args('plan'), { openPort: () => f.port });
      void runCli(d.base);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const hard = [...d.timers.values()].find(t => t.ms === BUDGET.hardExitMs);
      expect(hard).toBeDefined();
      hard?.fn();
      expect(d.exits).toEqual([3]);
      expect(summary(d.lines)).toMatchObject({ code: 'hard_timeout', outcome: 'refused', exit: 3, closure: 'unverified', resources: 'unverified' });
      hard?.fn();
      expect(d.lines).toHaveLength(1); expect(d.exits).toEqual([3]);
    });
  });

  it('el token de bloqueo y las sentencias son los de F1.2b-1', () => {
    expect(LOCK_KEY).toBe('4620462443122130743');
    expect(SQL.LOCK_SQL).toContain('pg_try_advisory_lock($1::bigint)');
  });
});

describe('contrato de salida de definiciones y ruta compilada', () => {
  it.each([1, 2] as const)('stdout exacto para prefijo %i y catálogo en cualquier orden', async prefix => {
    // Ambos prefijos: el catálogo trae las definiciones tal como las imprime PostgreSQL y el pin del manifiesto las verifica.
    const rows = withObservedDefinitions(derivePrefix(SCHEMA_MANIFEST, prefix));
    const digest = definitionsDigest(rows);
    const lines = rows.flatMap(r => r.kind === 'con' && r.type === 'c' ? [{ kind: 'check', table: r.table_name, name: r.name, definition: normalizeExpression(r.definition!) }] :
      r.kind === 'idx' && r.predicate !== null ? [{ kind: 'predicate', table: r.table_name, name: r.name, definition: normalizeExpression(r.predicate!) }] : [])
      .sort((a, b) => { for (const key of ['kind', 'table', 'name'] as const) { if (a[key] < b[key]) return -1; if (a[key] > b[key]) return 1; } return 0; });
    const expected = [SUMMARY_PREFIX + JSON.stringify({
      command: 'plan', target: 'agenda_test', outcome: 'planned', ok: true, code: null, sqlstate: null,
      state: prefix === 2 ? 'applied' : 'upgradable', stage: 'structure', structure: 'verified', structureDigest: digest,
      executed: SCHEMA_MANIFEST.slice(0, prefix).map(e => e.name), pending: SCHEMA_MANIFEST.slice(prefix).map(e => e.name), findings: [],
      committed: false, transaction: 'rolled_back', lock: 'released', closure: 'verified', resources: 'closed', elapsedMs: 0, exit: 0,
    }) + '\n', ...lines.map(line => DEFINITIONS_PREFIX + JSON.stringify(line) + '\n'),
    DEFINITIONS_PREFIX + JSON.stringify({ structureDigest: digest, count: lines.length }) + '\n'];
    for (const structure of [rows, [...rows].reverse()]) {
      const f = planPort({ prefix, structure });
      const d = deps([...args('plan'), '--show-definitions'], { openPort: () => f.port });
      expect(await runCli(d.base)).toBe(0);
      expect(d.lines).toEqual(expected);
      expect(f.events.filter(e => ['exec', 'migrate', 'revert', 'commit'].includes(e))).toEqual([]);
    }
  });
  it.each(['fresh', 'deriva', 'ilegible', 'omitidas'] as const)('solo resumen en %s', async mode => {
    const rows = derivePrefix(SCHEMA_MANIFEST, 2);
    rows.find(r => r.type === 'c')!.definition = "CHECK ('á' = 'á')";
    const f = mode === 'fresh' ? planPort() : planPort({ prefix: 2, structure: mode === 'omitidas' ? rows : mode === 'deriva' ? [] : null });
    const d = deps([...args('plan'), '--show-definitions'], { openPort: () => f.port });
    await runCli(d.base);
    const result = summary(d.lines);
    // El prefijo 2 está fijado: una definición distinta ya no pasa como «sin pin», es deriva y no se imprime ninguna definición.
    if (mode === 'omitidas') expect(result).toMatchObject({ structure: 'drift', code: 'schema_drift' });
    expect(d.lines.join('')).not.toContain(DEFINITIONS_PREFIX);
    expect(d.lines.join('')).not.toContain('á');
  });
  it('apply con el flag falla antes de credenciales incluso con confirmación correcta', async () => {
    const f = fakeFs(), openPort = jest.fn();
    const d = deps([...args('apply'), '--show-definitions'], { fs: f.fs, openPort });
    expect(await runCli(d.base)).toBe(2);
    expect(summary(d.lines).code).toBe('args_invalid');
    expect(f.calls).toEqual([]); expect(openPort).not.toHaveBeenCalled();
  });
  it('compila a la ruta contractual y main solo se ejecuta como programa', () => {
    const root = join(__dirname, '../../..');
    const config = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(join(root, 'tsconfig.json'), 'utf8')).config as { compilerOptions: { outDir: string; rootDir: string } };
    expect(config.compilerOptions).toMatchObject({ outDir: 'dist', rootDir: 'src' });
    expect(join(config.compilerOptions.outDir, 'database/schema-runner/cli.js')).toBe('dist/database/schema-runner/cli.js');
    const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(source).toContain('if (require.main === module) main();');
    expect(source).toContain('<plan|apply|revert> --env=test --target=agenda_test --confirm=<token> [--show-definitions solo en plan]');
    expect(source.indexOf('command = authorize(deps.argv)')).toBeLessThan(source.indexOf('const config = loadOwnerConfiguration'));
  });
});


describe('plan --show-drift: salida controlada', () => {
  const driftLines = (lines: string[]) => lines.filter(l => l.startsWith(DRIFT_PREFIX)).map(l => JSON.parse(l.slice(DRIFT_PREFIX.length)) as Record<string, unknown>);
  const tampered = () => { const rows = derivePrefix(SCHEMA_MANIFEST, 2); rows.find(r => r.kind === 'col')!.type = 'text'; rows.find(r => r.kind === 'col' && r.name !== rows.find(x => x.kind === 'col')!.name)!.not_null = false; return rows; };

  it('con deriva imprime el resumen, una línea por diferencia y un cierre con el conteo', async () => {
    const f = planPort({ prefix: 2, structure: tampered() });
    const d = deps([...args('plan'), '--show-drift'], { openPort: () => f.port });
    expect(await runCli(d.base)).toBe(2);
    expect(d.lines[0].startsWith(SUMMARY_PREFIX)).toBe(true);
    const parsed = JSON.parse(d.lines[0].slice(SUMMARY_PREFIX.length));
    expect(parsed).toMatchObject({ outcome: 'planned', code: 'schema_drift', structure: 'drift', structureDigest: null });
    expect(parsed).not.toHaveProperty('drift');
    const lines = driftLines(d.lines);
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2).every(l => l.category === 'changed' && ['type', 'not_null'].includes(l.field as string))).toBe(true);
    expect(lines[2]).toEqual({ count: 2, omitted: 0 });
    expect(d.lines.slice(1).every(l => l.startsWith(DRIFT_PREFIX) && l.endsWith('\n'))).toBe(true);
    expect(f.events.filter(e => ['exec', 'migrate', 'revert', 'commit'].includes(e))).toEqual([]);
  });
  it('la opción no cambia el resumen ni el código de salida respecto de la misma orden sin ella', async () => {
    const outputs: { lines: string[]; exit: number }[] = [];
    for (const extra of [[], ['--show-drift']]) {
      const f = planPort({ prefix: 2, structure: tampered() });
      const d = deps([...args('plan'), ...extra], { openPort: () => f.port });
      outputs.push({ exit: await runCli(d.base), lines: d.lines });
    }
    expect(outputs[1].exit).toBe(outputs[0].exit);
    expect(outputs[1].lines[0]).toBe(outputs[0].lines[0]);
    expect(outputs[0].lines).toHaveLength(1);
    expect(outputs[1].lines.length).toBeGreaterThan(1);
  });
  it('un esquema vacío, uno verificado o uno sin pin no imprimen diagnóstico', async () => {
    for (const port of [planPort(), planPort({ prefix: 2 }), planPort({ prefix: 1 })]) {
      const d = deps([...args('plan'), '--show-drift'], { openPort: () => port.port });
      await runCli(d.base);
      expect(d.lines).toHaveLength(1);
      expect(d.lines.join('')).not.toContain(DRIFT_PREFIX);
    }
  });
  it('con ambas opciones y deriva solo se imprime el diagnóstico, nunca las definiciones', async () => {
    const f = planPort({ prefix: 2, structure: tampered() });
    const d = deps([...args('plan'), '--show-definitions', '--show-drift'], { openPort: () => f.port });
    await runCli(d.base);
    expect(driftLines(d.lines).length).toBeGreaterThan(0);
    expect(d.lines.join('')).not.toContain(DEFINITIONS_PREFIX);
  });
  it('solo difiere el texto de una definición: dos digests y ninguna expresión', async () => {
    const rows = withObservedDefinitions(derivePrefix(SCHEMA_MANIFEST, 2)); rows.find(r => r.type === 'c')!.definition = "CHECK ('secreto-7Q' = 'secreto-7Q')";
    const f = planPort({ prefix: 2, structure: rows });
    const d = deps([...args('plan'), '--show-drift'], { openPort: () => f.port });
    expect(await runCli(d.base)).toBe(2);
    const drift = driftLines(d.lines);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toEqual({ category: 'definitions', expected: SCHEMA_MANIFEST[1].definitionsDigest, observed: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(drift[1]).toEqual({ count: 1, omitted: 0 });
    expect(d.lines.join('')).not.toContain('secreto-7Q');
  });
  it('estructura ilegible o con más de 2000 filas: una línea de categoría y el cierre, sin contenido', async () => {
    for (const structure of [null, 'ilegible', Array(2001).fill(derivePrefix(SCHEMA_MANIFEST, 2)[0])]) {
      const f = planPort({ prefix: 2, structure });
      const d = deps([...args('plan'), '--show-drift'], { openPort: () => f.port });
      expect(await runCli(d.base)).toBe(2);
      const lines = driftLines(d.lines);
      expect(lines).toHaveLength(2);
      expect(['unreadable', 'unknown']).toContain(lines[0].category);
      expect(lines[1]).toEqual({ count: 1, omitted: 0 });
    }
  });
  it('apply con la opción falla antes de credenciales y de abrir el puerto', async () => {
    for (const command of ['apply', 'revert']) {
      const f = fakeFs(), openPort = jest.fn();
      const d = deps([...args(command), '--show-drift'], { fs: f.fs, openPort });
      expect(await runCli(d.base)).toBe(2);
      expect(summary(d.lines).code).toBe('args_invalid');
      expect(f.calls).toEqual([]); expect(openPort).not.toHaveBeenCalled();
    }
  });
  it('la salida nunca contiene credenciales ni texto del driver', async () => {
    const f = planPort({ prefix: 2, structure: tampered() });
    const d = deps([...args('plan'), '--show-drift'], { openPort: () => f.port });
    await runCli(d.base);
    expect(d.lines.join('')).not.toContain(SECRET);
  });
});


describe('plan --show-drift con columnas de un CHECK en otro orden', () => {
  it('termina bien y sin líneas de deriva, como una estructura equivalente', async () => {
    const rows = withObservedDefinitions(derivePrefix(SCHEMA_MANIFEST, 2));
    const check = rows.find(r => r.name === 'CK_user_sessions_times')!;
    check.columns = ['expires_at', 'created_at', 'last_seen_at', 'revoked_at'];
    const f = planPort({ prefix: 2, structure: rows });
    const d = deps([...args('plan'), '--show-drift', '--show-definitions'], { openPort: () => f.port });
    expect(await runCli(d.base)).toBe(0);
    expect(JSON.parse(d.lines[0].slice(SUMMARY_PREFIX.length))).toMatchObject({ structure: 'verified', code: null });
    expect(d.lines.join('')).not.toContain(DRIFT_PREFIX);
    expect(d.lines.some(l => l.startsWith(DEFINITIONS_PREFIX))).toBe(true);
  });
});

describe('plan --show-drift con la forma real de PostgreSQL (orden observado y ARRAY[...])', () => {
  const realistic = () => {
    // Las definiciones ya vienen como las imprime PostgreSQL (ARRAY[...], ::text, ~~); solo se altera el orden de las columnas.
    const rows = withObservedDefinitions(derivePrefix(SCHEMA_MANIFEST, 2));
    rows.find(r => r.name === 'CK_user_sessions_times')!.columns = ['expires_at', 'created_at', 'last_seen_at', 'revoked_at'];
    return rows;
  };
  it('flujo completo con ambas opciones: sin deriva, verified con el pin y definiciones impresas', async () => {
    const f = planPort({ prefix: 2, structure: realistic() });
    const d = deps([...args('plan'), '--show-drift', '--show-definitions'], { openPort: () => f.port });
    expect(await runCli(d.base)).toBe(0);
    expect(JSON.parse(d.lines[0].slice(SUMMARY_PREFIX.length))).toMatchObject({ structure: 'verified', structureDigest: SCHEMA_MANIFEST[1].definitionsDigest, code: null });
    expect(d.lines.join('')).not.toContain(DRIFT_PREFIX);
    expect(d.lines.some(l => l.startsWith(DEFINITIONS_PREFIX))).toBe(true);
  });
  it('si la evaluación falla con diff vacío, la línea unknown indica la etapa', async () => {
    const rows = realistic();
    rows.find(r => r.name === 'CK_organization_memberships_role')!.definition = 'CHECK (role @ 1)';
    const f = planPort({ prefix: 2, structure: rows });
    const d = deps([...args('plan'), '--show-drift', '--show-definitions'], { openPort: () => f.port });
    expect(await runCli(d.base)).toBe(2);
    const drift = d.lines.filter(l => l.startsWith(DRIFT_PREFIX)).map(l => JSON.parse(l.slice(DRIFT_PREFIX.length)));
    expect(drift).toEqual([{ category: 'unknown', stage: 'definitions' }, { count: 1, omitted: 0 }]);
  });
});
