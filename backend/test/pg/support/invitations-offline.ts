import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteGate, markers } from './markers';
import { assertNodeTimeZone, INVITATION_TIME_ZONES, NODE_TIME_ZONE_EXTRA, parsePhase, parseInvitationTimeZone, phaseEnvironment } from './phase';
import { assertReadonlyQuery } from './readonly';
import { LogCapture } from './invitations-log-capture';
import {
  canSetCreatedAt, cutInsideTie, evaluateWaiters, expectedPaginationOrder, inviteeEmail, invitationActors, invitationsCleanupByIdSQL,
  invitationsCleanupSQL, invitationsCleanupTargets, invitationsMarkers, invitationsRunCommand, invitationsSQL, INVITATIONS_ZONE_CELLS,
  LOCK_WAIT, lostByMillisecondBound, microsOf, pageCuts, PAGINATION_LIMITS, PAGINATION_ROWS, PAGINATION_TIE_KEYS, type BlockingRow,
} from './invitations-fixture';

const ID = 'abcdef012345';
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
/** Source without comments, for checks about what the code does (the comments explain what it must not do). */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const block = (pid: number, blockers: number[], type: string | null = 'Lock'): BlockingRow => ({ pid, wait_event_type: type, wait_event: type === 'Lock' ? 'transactionid' : null, blockers });

export function registerInvitationsOfflineTests(): void {
  describe('invitations offline', () => {
    test('fase seleccionable, cleanup sigue reservada y la zona es obligatoria y cerrada', () => {
      expect(parsePhase('invitations', 'test')).toBe('invitations');
      expect(() => parsePhase('cleanup', 'test')).toThrow('requiere autorización');
      for (const bad of ['Invitations', 'invitation', 'invitations ', '']) expect(() => parsePhase(bad, 'test')).toThrow('AGENDA_B2B_PHASE');
      for (const zone of INVITATION_TIME_ZONES) {
        const env = { PGOPTIONS: 'inseguro', AGENDA_B2B_TIMEZONE: zone };
        expect(phaseEnvironment('invitations', env).PGOPTIONS).toBe(`-c TimeZone=${zone}`);
        expect(env.PGOPTIONS).toBe('inseguro');
      }
      expect([...INVITATION_TIME_ZONES]).toEqual(['UTC', 'America/Santiago', 'Asia/Kolkata', 'Pacific/Chatham']);
      for (const bad of [undefined, '', 'utc', ' UTC', 'America/New_York', 'UTC; DROP', "UTC'", 'Asia/Tokyo', 7]) {
        expect(() => parseInvitationTimeZone(bad)).toThrow('AGENDA_B2B_TIMEZONE');
        expect(() => phaseEnvironment('invitations', { AGENDA_B2B_TIMEZONE: bad as string })).toThrow('AGENDA_B2B_TIMEZONE');
      }
    });
    test('las demás fases ignoran la zona y siguen sin PGOPTIONS', () => {
      for (const phase of ['offline', 'dml', 'http', 'auth', 'companies', 'companies-write'] as const) {
        expect(phaseEnvironment(phase, { PGOPTIONS: 'x', AGENDA_B2B_TIMEZONE: 'UTC' })).not.toHaveProperty('PGOPTIONS');
      }
      expect(phaseEnvironment('readonly', { AGENDA_B2B_TIMEZONE: 'UTC' }).PGOPTIONS).toBe('-c default_transaction_read_only=on');
      expect(read('pg-setup.cjs')).toContain('AGENDA_B2B_TIMEZONE: process.env.AGENDA_B2B_TIMEZONE');
    });
    test('zona de Node de la ejecución adicional: solo la permitida, la realmente activa y distinta de la de PostgreSQL', () => {
      expect(NODE_TIME_ZONE_EXTRA).toBe('Pacific/Kiritimati');
      expect(() => assertNodeTimeZone({ AGENDA_B2B_TIMEZONE: 'UTC' }, 'America/Santiago')).not.toThrow();
      expect(() => assertNodeTimeZone({ AGENDA_B2B_TIMEZONE: 'Asia/Kolkata', AGENDA_B2B_EXPECT_NODE_TZ: NODE_TIME_ZONE_EXTRA }, NODE_TIME_ZONE_EXTRA)).not.toThrow();
      expect(() => assertNodeTimeZone({ AGENDA_B2B_TIMEZONE: 'Asia/Kolkata', AGENDA_B2B_EXPECT_NODE_TZ: NODE_TIME_ZONE_EXTRA }, 'UTC')).toThrow('TZ debe fijarse');
      expect(() => assertNodeTimeZone({ AGENDA_B2B_TIMEZONE: 'UTC', AGENDA_B2B_EXPECT_NODE_TZ: 'Asia/Tokyo' }, 'Asia/Tokyo')).toThrow('solo admite');
      expect(() => assertNodeTimeZone({ AGENDA_B2B_EXPECT_NODE_TZ: NODE_TIME_ZONE_EXTRA }, NODE_TIME_ZONE_EXTRA)).toThrow('AGENDA_B2B_TIMEZONE');
    });
    test('el gate se arma solo con identidad, esquema y línea base, y readonly nunca', () => {
      for (const missing of ['identity', 'schema', 'baseline'] as const) {
        const gate = new DeleteGate('invitations');
        for (const check of ['identity', 'schema', 'baseline'] as const) if (check !== missing) gate.mark(check);
        expect(() => gate.arm()).toThrow(); expect(() => gate.assertArmed()).toThrow();
        gate.mark(missing); gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
      }
    });

    test('marcadores: cinco reservas distintas y acotadas, invitados fuera de las reservas y de otras fases', () => {
      const m = invitationsMarkers(ID), targets = invitationsCleanupTargets(ID);
      expect(invitationActors).toEqual(['cmA', 'cmB', 'wA', 'mA', 'dA']);
      expect(m.reserved).toHaveLength(5);
      expect(new Set(m.reserved.map(r => r.email)).size).toBe(5);
      expect(new Set(m.reserved.map(r => r.organizationName)).size).toBe(5);
      for (const r of m.reserved) {
        expect(r.email).toMatch(/^b2b-abcdef012345-6[0-4]@agenda-b2b\.test$/);
        expect(r.email.length <= 120 && [...r.organizationName].length <= 80).toBe(true);
        expect(r.email + r.organizationName).not.toMatch(/[%_'"\\]/);
      }
      expect(targets.emails).toEqual(m.reserved.map(r => r.email));
      expect(targets.organizationNames).toEqual([m.byActor.cmA.organizationName, m.byActor.cmB.organizationName]);
      const invitees = Array.from({ length: 100 }, (_, n) => inviteeEmail(ID, n));
      expect(new Set(invitees).size).toBe(100);
      for (const email of invitees) {
        expect(email).toMatch(/^b2b-abcdef012345-2\d\d@agenda-b2b\.test$/);
        expect(targets.emails.includes(email) || markers(ID, 0, 'x').email === email).toBe(false);
      }
      for (const bad of [-1, 100, 1.5, NaN]) expect(() => inviteeEmail(ID, bad)).toThrow('fuera de rango');
      expect(() => inviteeEmail('mal', 0)).toThrow('runId');
    });
    test('limpieza por marcadores exactos: orden, parámetros y sin patrones', () => {
      expect(Object.keys(invitationsCleanupSQL)).toEqual(['invitationCompanies', 'invitations', 'sessions', 'accesses', 'companies', 'memberships', 'users', 'organizations']);
      for (const sql of Object.values(invitationsCleanupSQL)) {
        expect(sql).toMatch(/^DELETE FROM public\.\w+ WHERE /);
        expect(sql).toMatch(/\$1/);
        expect(sql).not.toMatch(/LIKE|~|name_key|ID_PLACEHOLDER/i);
        expect(sql).toContain('ANY($');
        expect(() => assertReadonlyQuery(sql)).toThrow('readonly');
      }
      expect(invitationsCleanupSQL.accesses.indexOf('company_accesses')).toBe(Object.values(invitationsCleanupSQL).indexOf(invitationsCleanupSQL.accesses) === 3 ? 'DELETE FROM public.'.length : -1);
    });
    test('limpieza por ids exactos: hijos antes que padres, company_accesses antes de empresas y membresías', () => {
      const keys = Object.keys(invitationsCleanupByIdSQL);
      expect(keys).toEqual(['invitationCompanies', 'invitations', 'sessions', 'accesses', 'companies', 'memberships', 'users', 'organizations']);
      const table = (sql: string) => /^DELETE FROM public\.(\w+) /.exec(sql)![1];
      const order = Object.values(invitationsCleanupByIdSQL).map(table);
      expect(order).toEqual(['invitation_companies', 'invitations', 'user_sessions', 'company_accesses', 'companies', 'organization_memberships', 'users', 'organizations']);
      for (const sql of Object.values(invitationsCleanupByIdSQL)) {
        expect(sql).toMatch(/ANY\(\$\d::uuid\[\]\)/);
        expect(sql).not.toMatch(/LIKE|~|'/);
        expect(() => assertReadonlyQuery(sql)).toThrow('readonly');
      }
      expect(order.indexOf('company_accesses')).toBeLessThan(order.indexOf('companies'));
      expect(order.indexOf('company_accesses')).toBeLessThan(order.indexOf('organization_memberships'));
      expect(order.indexOf('invitations')).toBeLessThan(order.indexOf('organization_memberships'));
      expect(order.indexOf('user_sessions')).toBeLessThan(order.indexOf('organization_memberships'));
    });
    test('connected.ts: limpieza por ids y respaldo en este orden, finally con las diez tablas vacías, y no promete limpieza tras una terminación forzada', () => {
      const source = read('connected.ts');
      const body = source.slice(source.indexOf('async function cleanupInvitations('), source.indexOf("    /** Backends of THIS run's application pool"));
      const byId = [...body.matchAll(/invitationsCleanupByIdSQL\.(\w+)/g)].map(m => m[1]);
      const backup = [...body.matchAll(/invitationsCleanupSQL\.(\w+)/g)].map(m => m[1]);
      expect(byId).toEqual(Object.keys(invitationsCleanupByIdSQL));
      expect(backup).toEqual(Object.keys(invitationsCleanupSQL));
      expect(body.indexOf('} finally {')).toBeGreaterThan(body.indexOf('invitationsCleanupByIdSQL.organizations'));
      expect(body.trimEnd().endsWith('}')).toBe(true);
      expect(body).toContain('await empty();');
      expect(source).toContain('does NOT survive a forced termination');
      expect(source).toContain("if (invitationsTargets) { await cleanupInvitations(userIds, orgIds); return; }");
      expect(source).toContain("} else if (phase === 'invitations') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });");
      expect(source).toContain('if (locker?.isInitialized) await locker.destroy();');
    });

    test('ninguna sentencia del observador ni del locker escribe accepted_at o accepted_by_user_id; las escrituras están enumeradas', () => {
      const http = read('http-invitations.ts');
      for (const text of [code('invitations-fixture.ts'), code('http-invitations.ts'), code('invitations-logging.ts')]) {
        expect(text).not.toContain('accepted_by_user_id');
        expect(text).not.toMatch(/accepted_at\s*=(?![=])/);
        expect(text).not.toMatch(/SET\s+accepted/i);
      }
      const statements = Object.entries(invitationsSQL) as [string, string][];
      for (const [name, sql] of statements) {
        expect(sql).not.toMatch(/\b(ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM)\b/i);
        if (/accepted_at/.test(sql)) expect(sql).toMatch(/^SELECT /);
        expect(name).toBeTruthy();
      }
      const writes = statements.filter(([, sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)).map(([name]) => name).sort();
      expect(writes).toEqual(['crossCompany', 'setCreatedAt']);
      expect(invitationsSQL.setCreatedAt).toBe('UPDATE public.invitations SET created_at = $3::timestamptz WHERE id = $1 AND organization_id = $2');
      expect(invitationsSQL.crossCompany).toBe('INSERT INTO public.invitation_companies (invitation_id, company_id, organization_id) VALUES ($1, $2, $3)');
      const locks = statements.filter(([, sql]) => /^(LOCK|SET)\b|FOR UPDATE/.test(sql)).map(([name]) => name).sort();
      expect(locks).toEqual(['lockCompanies', 'lockRow', 'lockerIdleTimeout', 'lockerLockTimeout', 'observerZone']);
      // Writes written inline in the scenario file: only the observer's seeding of the three members.
      const inline = [...http.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(\w+)/g)].map(m => `${m[1]} ${m[2]}`).sort();
      expect(inline).toEqual(['INSERT INTO organization_memberships', 'INSERT INTO users']);
      expect(http).toContain('gate.assertArmed();');
    });
    test('SQL del locker: bloqueos acotados y siempre con rollback; sin escritura de datos', () => {
      expect(invitationsSQL.lockerLockTimeout).toBe("SET LOCAL lock_timeout = '1s'");
      expect(invitationsSQL.lockerIdleTimeout).toBe("SET LOCAL idle_in_transaction_session_timeout = '10s'");
      expect(invitationsSQL.lockRow).toBe('SELECT id FROM public.invitations WHERE id = $1 AND organization_id = $2 FOR UPDATE');
      expect(invitationsSQL.lockCompanies).toBe('LOCK TABLE public.invitation_companies IN SHARE MODE');
      const http = read('http-invitations.ts');
      const holding = http.slice(http.indexOf('const holding = async'), http.indexOf('/** Brief concurrency hold'));
      expect(holding).toContain('startTransaction()');
      expect(holding).toContain('rollbackTransaction()');
      expect(holding).not.toContain('commitTransaction');
      expect(holding).toContain('finally');
      expect(holding).toContain('Promise.allSettled(pending)');
      expect(http).not.toContain('commitTransaction');
      expect(read('invitations-fixture.ts')).not.toContain('commitTransaction');
    });
    test('los bloqueos breves y el timeout de rollback son escenarios distintos y con plazos acotados', () => {
      expect(LOCK_WAIT.briefObserveMs).toBeLessThan(LOCK_WAIT.timeoutExpectedMs);
      expect(LOCK_WAIT.timeoutMinMs).toBeLessThan(LOCK_WAIT.timeoutExpectedMs);
      expect(LOCK_WAIT.timeoutExpectedMs).toBeLessThan(LOCK_WAIT.timeoutMaxMs);
      const http = read('http-invitations.ts');
      expect(http).toContain('const briefRace = async');
      expect(http.match(/holding\(\[\{ sql: SQL\.lockCompanies \}\]/g)).toHaveLength(2);
      expect(http).toContain('LOCK_WAIT.timeoutMinMs');
      expect(http.match(/briefRace\(/g)!.length).toBe(2);
      // The timeout scenarios never release the lock before the response arrives.
      const timeout = http.slice(http.indexOf("step = 'rollback real de renovar tras revocar la anterior'"), http.indexOf("step = 'rollback real de crear con las empresas bloqueadas'"));
      expect(timeout).not.toContain('release()');
    });

    test('esperas identificadas por los pids de esta prueba y sus bloqueadores', () => {
      const own = [10, 11], locker = 99;
      expect(evaluateWaiters([block(10, [locker])], { locker, own, expected: 1 })).toEqual({ state: 'ready' });
      // The second request queues behind the first one, which waits on the locker.
      expect(evaluateWaiters([block(10, [locker]), block(11, [10])], { locker, own, expected: 2 })).toEqual({ state: 'ready' });
      expect(evaluateWaiters([block(10, [locker]), block(11, [locker, 10])], { locker, own, expected: 2 })).toEqual({ state: 'ready' });
      expect(evaluateWaiters([block(10, [locker]), block(11, [], null)], { locker, own, expected: 2 }).state).toBe('waiting');
      expect(evaluateWaiters([], { locker, own, expected: 1 }).state).toBe('waiting');
      // Sessions of the same role that are not this run's are not counted, and cannot be blockers.
      expect(evaluateWaiters([block(10, [locker]), block(500, [locker])], { locker, own, expected: 1 })).toEqual({ state: 'ready' });
      expect(evaluateWaiters([block(10, [500])], { locker, own, expected: 1 }).state).toBe('invalid');
      expect(evaluateWaiters([block(10, [locker, 500])], { locker, own, expected: 1 }).state).toBe('invalid');
      // More waiters than expected, or a chain that never reaches the locker.
      expect(evaluateWaiters([block(10, [locker]), block(11, [10])], { locker, own, expected: 1 }).state).toBe('invalid');
      expect(evaluateWaiters([block(10, [11]), block(11, [10])], { locker, own, expected: 2 }).state).toBe('invalid');
      // Waits that are not lock waits do not count.
      expect(evaluateWaiters([block(10, [locker]), block(11, [], 'IO')], { locker, own, expected: 1 })).toEqual({ state: 'ready' });
      expect(evaluateWaiters([block(10, [], 'Client')], { locker, own, expected: 1 }).state).toBe('waiting');
    });
    test('la consulta de esperas pide solo los pids de la aplicación de esta prueba', () => {
      expect(invitationsSQL.appBlocking).toContain('pg_blocking_pids(a.pid)');
      expect(invitationsSQL.appBlocking).toContain('a.pid = ANY($1::int[])');
      expect(invitationsSQL.appBlocking).toContain("a.application_name = 'agenda-backend'");
      expect(invitationsSQL.appBlocking).toContain('a.usename = current_user');
      const http = read('http-invitations.ts');
      expect(http).toContain('const own = await appPids();');
      expect(http).toContain('evaluateWaiters(rows, { locker: blocker, own, expected })');
      expect(read('connected.ts')).toContain('.filter(pid => !beforePids.has(pid))');
    });

    test('paginación: valores exactos, un mismo milisegundo, empates y microsegundos', () => {
      expect(PAGINATION_ROWS.map(r => `${r.key} ${r.at}`)).toEqual([
        'r0 2026-03-01T10:00:00.123999Z', 'r1 2026-03-01T10:00:00.123500Z', 'r2 2026-03-01T10:00:00.123001Z', 'r3 2026-03-01T10:00:00.123000Z',
        'r4 2026-03-01T10:00:00.122999Z', 'r5 2026-03-01T10:00:00.123500Z', 'r6 2026-03-01T10:00:00.123500Z', 'r7 2026-03-01T09:59:59.999999Z',
      ]);
      const sameMs = PAGINATION_ROWS.filter(r => r.at.startsWith('2026-03-01T10:00:00.123'));
      expect(sameMs).toHaveLength(6);
      expect(new Set(sameMs.map(r => r.at)).size).toBe(4);
      expect(new Set(sameMs.map(r => microsOf(r.at))).size).toBe(4);
      expect(PAGINATION_ROWS.filter(r => (PAGINATION_TIE_KEYS as readonly string[]).includes(r.key)).map(r => r.at)).toEqual(Array(3).fill('2026-03-01T10:00:00.123500Z'));
      expect(microsOf('2026-03-01T10:00:00.123001Z') - microsOf('2026-03-01T10:00:00.123000Z')).toBe(1n);
      expect(() => microsOf('2026-03-01T10:00:00.123Z')).toThrow('seis decimales');
      expect([...PAGINATION_LIMITS]).toEqual([1, 2, 3, 5, 8]);
    });
    test.each([['ids crecientes con la posición'], ['ids decrecientes con la posición']])('paginación: el orden esperado, los cortes en empates y lo que un cursor en milisegundos pierde (%s)', label => {
      const asc = label.includes('crecientes');
      const rows = PAGINATION_ROWS.map((r, i) => ({ id: `01900000-0000-7000-8000-${String(asc ? i + 1 : 99 - i).padStart(12, '0')}`, at: r.at }));
      const order = expectedPaginationOrder(rows);
      expect(order).toHaveLength(8);
      const byId = new Map(rows.map(r => [r.id, r.at]));
      const ordered = order.map(id => ({ id, at: byId.get(id)! }));
      for (let i = 1; i < ordered.length; i++) {
        const a = microsOf(ordered[i - 1].at), b = microsOf(ordered[i].at);
        expect(a > b || (a === b && ordered[i - 1].id > ordered[i].id)).toBe(true);
      }
      // The three tied rows are adjacent and descend by id.
      const tied = ordered.filter(r => r.at === '2026-03-01T10:00:00.123500Z');
      expect(tied).toHaveLength(3);
      expect(tied.map(r => r.id)).toEqual([...tied.map(r => r.id)].sort().reverse());
      expect(cutInsideTie(ordered, 2)).toBe(true);
      expect(cutInsideTie(ordered, 3)).toBe(true);
      expect(pageCuts(8, 3)).toEqual([3, 6]);
      expect(pageCuts(8, 8)).toEqual([]);
      for (const limit of PAGINATION_LIMITS) {
        const pages: string[] = [];
        for (let start = 0; start < order.length; start += limit) pages.push(...order.slice(start, start + limit));
        expect(pages).toEqual(order);
      }
      const lost = lostByMillisecondBound(rows, ordered[0]);
      const idOf = (key: string) => rows[PAGINATION_ROWS.findIndex(r => r.key === key)].id;
      for (const key of ['r1', 'r5', 'r6', 'r2']) expect(lost).toContain(idOf(key));
      expect(lost.length).toBeGreaterThanOrEqual(4);
      expect(lost).not.toContain(idOf('r4'));
      expect(lost).not.toContain(idOf('r7'));
    });
    test('created_at: cada valor del fixture respeta los checks de fechas; un valor que los rompe se rechaza', () => {
      const clock = Date.parse('2026-11-25T12:00:00.000Z');
      const open = { expires_at: new Date(clock + 7 * 86400000), revoked_at: null, accepted_at: null };
      for (const r of PAGINATION_ROWS) expect(canSetCreatedAt(open, r.at)).toBe(true);
      // expires_at > created_at with microsecond precision: .123 ms expiry rejects .123999 but accepts .122999.
      const tight = { expires_at: new Date('2026-03-01T10:00:00.123Z'), revoked_at: null, accepted_at: null };
      expect(canSetCreatedAt(tight, '2026-03-01T10:00:00.123999Z')).toBe(false);
      expect(canSetCreatedAt(tight, '2026-03-01T10:00:00.123000Z')).toBe(false);
      expect(canSetCreatedAt(tight, '2026-03-01T10:00:00.122999Z')).toBe(true);
      // revoked_at >= created_at, and acceptances are never touched.
      const revoked = { expires_at: open.expires_at, revoked_at: new Date('2026-03-01T10:00:00.123Z'), accepted_at: null };
      expect(canSetCreatedAt(revoked, '2026-03-01T10:00:00.123500Z')).toBe(false);
      expect(canSetCreatedAt(revoked, '2026-03-01T10:00:00.122999Z')).toBe(true);
      expect(canSetCreatedAt({ ...open, accepted_at: new Date(clock) }, '2026-03-01T10:00:00.123000Z')).toBe(false);
    });

    test('el logger conserva opciones y serializadores reales: solo cambia el destino', () => {
      const real = read('../../../src/logging/logging.module.ts'), capturing = read('invitations-logging.ts');
      expect(real).toContain('createLoggerOptions(config, undefined, ids)');
      expect(capturing).toContain('createLoggerOptions(config, logCapture.stream, ids)');
      expect(capturing).toContain('useExisting: true');
      expect(capturing).toContain('inject: [AppConfigService, IdGenerator]');
      expect(code('invitations-logging.ts')).not.toMatch(/redact|serializers|censor|logLevel/);
      expect(read('connected.ts')).toContain('.overrideModule(LoggingModule).useModule(CapturingLoggingModule)');
      expect(read('http-invitations.ts')).toContain("['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)");
    });
    test('captura en memoria: acumula, se reinicia y avisa si no pudo conservar todo', () => {
      const capture = new LogCapture();
      capture.stream.write('uno\n'); capture.stream.write(Buffer.from('dos\n'));
      expect(capture.text()).toBe('uno\ndos\n'); expect(capture.overflowed()).toBe(false);
      capture.reset(); expect(capture.text()).toBe('');
      capture.stream.write('x'.repeat(LogCapture.LIMIT + 1));
      expect(capture.overflowed()).toBe(true); expect(capture.text()).toBe('');
    });

    test('zona horaria: se comprueba la conexión de la aplicación por pid, el observador y el locker', () => {
      const http = read('http-invitations.ts');
      expect(invitationsSQL.poolTimeZone).toBe("SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS tz, pg_sleep(0.2) AS slept");
      expect(http).toContain('Array.from({ length: 8 }, () => source.query(SQL.poolTimeZone)');
      expect(http).toContain('new Set(poolPids).size === 8 && pool.every(r => r[0].tz === zone)');
      expect(http).toContain('!poolPids.includes(lockerPid) && !poolPids.includes(observerPid)');
      expect(http).toContain("observerZone === 'Asia/Tokyo' && observerZone !== zone");
      const connected = read('connected.ts');
      expect(connected).toContain('process.env.PGOPTIONS !== `-c TimeZone=${zone}`');
      expect(connected).toContain('assertNodeTimeZone(process.env, Intl.DateTimeFormat().resolvedOptions().timeZone)');
      expect(invitationsSQL.createdAtText).toContain("created_at AT TIME ZONE 'UTC'");
    });
    test('FK cruzada: transacción independiente que se revierte, con SQLSTATE y constraint exactos', () => {
      const http = read('http-invitations.ts');
      const cross = http.slice(http.indexOf('const cross = async'), http.indexOf('const viaCompany'));
      expect(cross).toContain('locker.createQueryRunner()');
      expect(cross).toContain('startTransaction()');
      expect(cross).toContain('rollbackTransaction()');
      expect(http).toContain("viaCompany.sqlState === '23503' && viaCompany.constraint === 'FK_invitation_companies_company'");
      expect(http).toContain("viaInvitation.sqlState === '23503' && viaInvitation.constraint === 'FK_invitation_companies_invitation'");
    });

    describe('comandos finales', () => {
      const cell = (cmd: string) => cmd;
      test('el texto fija las cinco ejecuciones, se detiene al primer fallo y no usa break ni oculta códigos', () => {
        const command = invitationsRunCommand({ backend: '/ruta/backend' });
        expect(INVITATIONS_ZONE_CELLS.map(c => `${c.zone}${c.nodeZone ? `+${c.nodeZone}` : ''}`)).toEqual(['UTC', 'America/Santiago', 'Asia/Kolkata', 'Pacific/Chatham', 'Asia/Kolkata+Pacific/Kiritimati']);
        for (const line of ['  cell UTC', '  cell America/Santiago', '  cell Asia/Kolkata', '  cell Pacific/Chatham', '  cell Asia/Kolkata Pacific/Kiritimati']) expect(command).toContain(`\n${line}\n`);
        for (const needle of ['set -e', 'cd "/ruta/backend" || exit 1', '. ./.env.test', 'AGENDA_B2B_PHASE=invitations', 'LOG_LEVEL=info', 'APP_ALLOWED_ORIGINS=https://app.agenda.test',
          '--runInBand test/pg/registration.pg.spec.ts', '|| { echo', 'exit 1; }', '(exit $b2b_rc)']) expect(cell(command)).toContain(needle);
        expect(command.startsWith('(\n')).toBe(true);
        expect(command).not.toMatch(/\bbreak\b|\|\| true|\bfor\b|\bwhile\b|;\s*;|2>\/dev\/null|set \+e/);
        expect(command).not.toMatch(/DATABASE_|PASSWORD|echo .*\$\{?DATABASE/i);
      });
      const shells = ['bash', 'zsh'].filter(shell => spawnSync(shell, ['-c', 'exit 0']).status === 0);
      test('hay al menos bash disponible para ejercitar el control de flujo', () => expect(shells).toContain('bash'));
      test.each(shells)('%s: éxito completo = 0 con las cinco ejecuciones; un fallo detiene el resto y devuelve distinto de cero', shell => {
        const dir = mkdtempSync(join(tmpdir(), 'b2b-cmd-'));
        const log = join(dir, 'log'), stub = join(dir, 'stub.sh');
        writeFileSync(stub, '#!/bin/sh\necho "$AGENDA_B2B_PHASE|$AGENDA_B2B_TIMEZONE|${TZ-sin TZ}|${AGENDA_B2B_EXPECT_NODE_TZ-sin esperado}|$LOG_LEVEL|$APP_ALLOWED_ORIGINS|$NODE_ENV" >> "$STUB_LOG"\n[ "$AGENDA_B2B_TIMEZONE" = "$STUB_FAIL_ZONE" ] && exit 3\nexit 0\n');
        chmodSync(stub, 0o755);
        const command = invitationsRunCommand({ backend: dir, jest: `sh ${stub}`, loadEnv: ':' });
        const run = (failZone: string) => {
          writeFileSync(log, '');
          const env: Record<string, string> = { PATH: process.env.PATH ?? '', STUB_LOG: log, STUB_FAIL_ZONE: failZone };
          const result = spawnSync(shell, ['-c', `${command}\nexit $?`], { env, encoding: 'utf8' });
          return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
        };
        const ok = run('ninguna');
        expect(ok.status).toBe(0);
        expect(ok.lines).toEqual([
          'invitations|UTC|sin TZ|sin esperado|info|https://app.agenda.test|test', 'invitations|America/Santiago|sin TZ|sin esperado|info|https://app.agenda.test|test',
          'invitations|Asia/Kolkata|sin TZ|sin esperado|info|https://app.agenda.test|test', 'invitations|Pacific/Chatham|sin TZ|sin esperado|info|https://app.agenda.test|test',
          'invitations|Asia/Kolkata|Pacific/Kiritimati|Pacific/Kiritimati|info|https://app.agenda.test|test',
        ]);
        expect(ok.stdout).toContain('todas las ejecuciones terminaron bien');
        for (const [zone, executed] of [['UTC', 1], ['America/Santiago', 2], ['Pacific/Chatham', 4]] as const) {
          const failed = run(zone);
          expect(failed.status).not.toBe(0);
          expect(failed.lines).toHaveLength(executed);
          expect(failed.stderr).toContain(`FALLÓ: PostgreSQL=${zone}`);
          expect(failed.stdout).not.toContain('todas las ejecuciones terminaron bien');
          expect(failed.stdout).toContain(`código de salida=1`);
        }
        const last = run('Asia/Kolkata'); // the first Kolkata cell fails: the extra one never runs
        expect(last.status).not.toBe(0); expect(last.lines).toHaveLength(3);
        expect(readdirSync(dir).sort()).toEqual(['log', 'stub.sh']);
      });
    });
  });
}
