import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSERT_SESSION_SQL } from '../../../src/auth/session-issue';
import { INSERT_ACCESSES_SQL, INSERT_USER_SQL, LOCK_INVITATION_BY_TOKEN_SQL } from '../../../src/invitations/invitation-acceptance-sql';
import { acceptanceCleanupTargets, acceptanceInvitee, acceptanceLocks, acceptanceMarkers, acceptanceRunCommand, acceptanceSQL, ACCEPTANCE_COMPETITORS, ACCEPTANCE_INVITEES, ACCEPTANCE_ZONE_CELLS } from './acceptance-fixture';
import { invitationsCleanupByIdSQL, invitationsCleanupSQL, invitationsSQL } from './invitations-fixture';
import { holding, matchWaiters, startsLike, waitForWaiters, WAITERS_SQL, type LockerLike, type RunnerLike, type WaiterRow } from './lock-support';
import { DeleteGate } from './markers';
import { ACCEPTANCE_TIME_ZONES, parseAcceptanceTimeZone, parsePhase, phaseEnvironment } from './phase';

const ID = 'abcdef012345';
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const waiter = (pid: number, blockers: number[], query: string): WaiterRow => ({ pid, wait_event_type: 'Lock', wait_event: 'relation', blockers, query });

export function registerAcceptanceOfflineTests(): void {
  describe('acceptance offline', () => {
    test('fase seleccionable y zonas cerradas: UTC y Pacific/Chatham', () => {
      expect(parsePhase('acceptance', 'test')).toBe('acceptance');
      expect([...ACCEPTANCE_TIME_ZONES]).toEqual(['UTC', 'Pacific/Chatham']);
      for (const zone of ACCEPTANCE_TIME_ZONES) expect(phaseEnvironment('acceptance', { PGOPTIONS: 'x', AGENDA_B2B_TIMEZONE: zone }).PGOPTIONS).toBe(`-c TimeZone=${zone}`);
      for (const bad of [undefined, '', 'America/Santiago', 'Asia/Kolkata', 'utc', ' UTC', 'UTC; DROP', 'Pacific/Chatham ']) {
        expect(() => parseAcceptanceTimeZone(bad)).toThrow('fase acceptance');
        expect(() => phaseEnvironment('acceptance', { AGENDA_B2B_TIMEZONE: bad as string })).toThrow('fase acceptance');
      }
      for (const other of ['Acceptance', 'accept', 'acceptance ']) expect(() => parsePhase(other, 'test')).toThrow('AGENDA_B2B_PHASE');
      expect(phaseEnvironment('companies', { AGENDA_B2B_TIMEZONE: 'UTC' })).not.toHaveProperty('PGOPTIONS');
    });
    test('el gate se arma con identidad, esquema y línea base', () => {
      for (const missing of ['identity', 'schema', 'baseline'] as const) {
        const gate = new DeleteGate('acceptance');
        for (const check of ['identity', 'schema', 'baseline'] as const) if (check !== missing) gate.mark(check);
        expect(() => gate.arm()).toThrow();
        gate.mark(missing); gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
      }
    });
    test('todos los correos y nombres de organización quedan reservados antes de armar, incluido el registro competidor', () => {
      const m = acceptanceMarkers(ID), t = acceptanceCleanupTargets(ID);
      expect(m.competitors).toHaveLength(ACCEPTANCE_COMPETITORS); expect(m.invitees).toHaveLength(ACCEPTANCE_INVITEES);
      expect(t.emails).toEqual([m.cmA.email, m.cmB.email, ...m.invitees]);
      expect(t.organizationNames).toEqual([m.cmA.organizationName, m.cmB.organizationName, ...m.competitors]);
      expect(new Set(t.emails).size).toBe(t.emails.length); expect(new Set(t.organizationNames).size).toBe(t.organizationNames.length);
      for (const email of t.emails) { expect(email).toMatch(/^b2b-abcdef012345-\d{3}@agenda-b2b\.test$/); expect(email.length).toBeLessThanOrEqual(120); }
      for (const name of t.organizationNames) { expect([...name].length).toBeLessThanOrEqual(80); expect(name).not.toMatch(/[%_'"\\]/); }
      expect(acceptanceInvitee(ID, 0)).toBe(m.invitees[0]);
      for (const bad of [-1, ACCEPTANCE_INVITEES, 1.5, NaN]) expect(() => acceptanceInvitee(ID, bad)).toThrow('fuera de las reservas');
      expect(() => acceptanceMarkers('mal')).toThrow('runId');
      expect(code('http-acceptance.ts')).toContain('const email = acceptanceInvitee(id, n), organizationName = reservations.competitors[round];');
      expect(code('http-acceptance.ts')).not.toMatch(/email: `|@agenda-b2b/);
    });

    test('el observador solo lee y el locker solo bloquea; ninguna escritura propia del arnés', () => {
      for (const sql of Object.values(acceptanceSQL)) { expect(sql).toMatch(/^SELECT /); expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|FOR UPDATE)\b/); }
      expect(acceptanceLocks.row).toBe('SELECT id FROM public.invitations WHERE id = $1 AND organization_id = $2 FOR UPDATE');
      for (const sql of [acceptanceLocks.users, acceptanceLocks.accesses, acceptanceLocks.sessions]) expect(sql).toMatch(/^LOCK TABLE public\.(users|company_accesses|user_sessions) IN SHARE MODE$/);
      const http = code('http-acceptance.ts');
      // Every direct database call of the scenarios uses one of the pure statement catalogues.
      const calls = [...http.matchAll(/\b(observer|locker|source)\.query\(([A-Za-z_.]+)/g)].map(m => m[2]);
      expect(calls.length).toBeGreaterThan(10);
      for (const argument of calls) expect(argument).toMatch(/^(SQL\.|invitationsSQL\.|sql$)/);
      for (const file of ['acceptance-fixture.ts', 'lock-support.ts']) expect(code(file)).not.toMatch(/(INSERT INTO|UPDATE public|DELETE FROM)/);
      expect(http).not.toMatch(/(UPDATE public|DELETE FROM|INSERT INTO public)/);
      for (const file of ['http-acceptance.ts', 'acceptance-fixture.ts', 'lock-support.ts']) expect(code(file)).not.toMatch(/accepted_(at|by_user_id)\s*=(?![=])|commitTransaction/);
    });
    test('la limpieza va por ids y marcadores en orden de hijos a padres, con las diez tablas vacías al final', () => {
      const source = read('connected.ts');
      const body = source.slice(source.indexOf('async function cleanupAcceptance('), source.indexOf('Exact ids first (every id the application returned or the observer seeded)'));
      expect([...body.matchAll(/invitationsCleanupByIdSQL\.(\w+)/g)].map(m => m[1])).toEqual(Object.keys(invitationsCleanupByIdSQL));
      expect([...body.matchAll(/invitationsCleanupSQL\.(\w+)/g)].map(m => m[1])).toEqual(Object.keys(invitationsCleanupSQL));
      expect(body).toContain('await empty();');
      expect(body.indexOf('} finally {')).toBeLessThan(body.indexOf('invitationsCleanupSQL.invitationCompanies'));
      expect(source).toContain('it does NOT survive a forced termination of the process.\n     */\n    async function cleanupAcceptance(');
      expect(source).toContain('if (acceptanceTargets) { await cleanupAcceptance(userIds, orgIds); return; }');
      const tables = Object.values(invitationsCleanupByIdSQL).map(sql => /^DELETE FROM public\.(\w+) /.exec(sql)![1]);
      for (const referenced of ['users', 'organization_memberships']) expect(tables.indexOf('invitations')).toBeLessThan(tables.indexOf(referenced));
      expect(tables.indexOf('company_accesses')).toBeLessThan(tables.indexOf('organization_memberships'));
    });
    test('cableado: zona verificada, locker, reloj controlado, logger real con captura y registro de la fase', () => {
      const connected = read('connected.ts');
      for (const needle of ["if (phase === 'acceptance') assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS);", "parseAcceptanceTimeZone(process.env.AGENDA_B2B_TIMEZONE)",
        "if (phase === 'invitations' || phase === 'acceptance') {\n          logCapture.reset();", "} else if (phase === 'acceptance') {\n          // Same as invitations",
        "} else if (phase === 'acceptance') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });",
        "if (phase === 'acceptance') registerAcceptanceTest("]) expect(connected).toContain(needle);
      expect(read('load-connected.cjs')).toContain("| 'acceptance'");
      const http = read('http-acceptance.ts');
      expect(http).toContain("['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)");
      expect(http).toContain('Array.from({ length: 8 }, () => source.query(invitationsSQL.poolTimeZone)');
      expect(http).toContain('log.length > 0 && log.includes(\'Solicitud finalizada.\')');
      expect(http).toContain('logs.overflowed()).toBe(false)');
      expect(http).toContain("formatAuthFailure(step, error, 'acceptance')");
    });
    test('los mensajes de diagnóstico no llevan secretos', () => {
      const lines = read('http-acceptance.ts').split('\n').filter(line => line.includes('console.'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toMatch(/token|PASSWORD|cookie|csrf|\.email\b|hash/i);
    });

    test('dónde espera cada petición: solo las sentencias previstas, una por espera', () => {
      const lock = startsLike(LOCK_INVITATION_BY_TOKEN_SQL), userInsert = startsLike(INSERT_USER_SQL), register = /^INSERT INTO ("public"\.)?"users"/;
      const own = [10, 11];
      const options = (patterns: RegExp[]) => ({ locker: 99, own, patterns });
      expect(matchWaiters([waiter(10, [99], LOCK_INVITATION_BY_TOKEN_SQL)], options([lock]))).toEqual({ state: 'ready' });
      expect(matchWaiters([waiter(10, [99], INSERT_USER_SQL), waiter(11, [99], 'INSERT INTO "users"("id") VALUES ($1)')], options([userInsert, register]))).toEqual({ state: 'ready' });
      expect(matchWaiters([waiter(10, [99], 'INSERT INTO "public"."users"("id") VALUES ($1)'), waiter(11, [99], INSERT_USER_SQL)], options([userInsert, register]))).toEqual({ state: 'ready' });
      expect(matchWaiters([waiter(10, [99], INSERT_USER_SQL), waiter(11, [99], INSERT_USER_SQL)], options([userInsert, userInsert]))).toEqual({ state: 'ready' });
      expect(matchWaiters([waiter(10, [99], INSERT_USER_SQL), waiter(11, [99], INSERT_USER_SQL)], options([userInsert, register])).state).toBe('invalid');
      expect(matchWaiters([waiter(10, [99], INSERT_SESSION_SQL)], options([startsLike(INSERT_ACCESSES_SQL)])).state).toBe('invalid');
      expect(matchWaiters([waiter(10, [99], INSERT_ACCESSES_SQL)], options([startsLike(INSERT_SESSION_SQL)])).state).toBe('invalid');
      expect(matchWaiters([waiter(10, [99], LOCK_INVITATION_BY_TOKEN_SQL)], options([lock, lock])).state).toBe('waiting');
      expect(matchWaiters([waiter(10, [500], LOCK_INVITATION_BY_TOKEN_SQL)], options([lock])).state).toBe('invalid');
      expect(matchWaiters([waiter(10, [99], LOCK_INVITATION_BY_TOKEN_SQL), waiter(500, [99], 'otra')], options([lock]))).toEqual({ state: 'ready' });
      expect(WAITERS_SQL).toContain('pg_blocking_pids(a.pid)'); expect(WAITERS_SQL).toContain('a.query');
      expect(WAITERS_SQL).toContain("a.application_name = 'agenda-backend' AND a.pid = ANY($1::int[])");
    });
    test('las sentencias esperadas se distinguen entre sí y de las de registro', () => {
      const management = /SELECT_INVITATION_FOR_UPDATE_SQL = `([^`$]+)/.exec(read('../../../src/invitations/invitations.service.ts'))![1];
      const manage = startsLike(management), lock = startsLike(LOCK_INVITATION_BY_TOKEN_SQL);
      expect(lock.test(management)).toBe(false); expect(manage.test(LOCK_INVITATION_BY_TOKEN_SQL)).toBe(false);
      expect(startsLike(INSERT_USER_SQL).test('INSERT INTO "users"("id")')).toBe(false);
      expect(/^INSERT INTO ("public"\.)?"users"/.test(INSERT_USER_SQL)).toBe(false);
      expect(startsLike('SELECT (a) [b] $1 + c?').test('SELECT (a) [b] $1 + c?')).toBe(true);
      expect(read('http-acceptance.ts')).toContain('const registerUserInsert = /^INSERT INTO ("public"\\.)?"users"/;');
    });

    function fakeLocker() {
      const events: string[] = [];
      let active = false;
      const runner: RunnerLike = {
        get isTransactionActive() { return active; },
        connect: async () => { events.push('connect'); }, startTransaction: async () => { active = true; events.push('begin'); },
        rollbackTransaction: async () => { active = false; events.push('rollback'); }, release: async () => { events.push('release'); },
        query: async sql => { events.push(sql); return sql === invitationsSQL.backendPid ? [{ pid: 99 }] : []; },
      };
      const locker: LockerLike = { createQueryRunner: () => runner };
      return { locker, events };
    }
    test('holding: bloqueo acotado, rollback siempre, liberación idempotente y peticiones esperadas aunque el cuerpo falle', async () => {
      const { locker, events } = fakeLocker();
      const result = await holding(locker, [{ sql: acceptanceLocks.users }], async ({ pid, release }) => { await release(); await release(); return pid; });
      expect(result).toBe(99);
      expect(events).toEqual(['connect', 'begin', invitationsSQL.lockerLockTimeout, invitationsSQL.lockerIdleTimeout, invitationsSQL.backendPid, acceptanceLocks.users, 'rollback', 'release']);
      const failing = fakeLocker();
      let settled = false;
      const pending = new Promise<void>(resolve => setTimeout(() => { settled = true; resolve(); }, 20));
      await expect(holding(failing.locker, [], async ({ track }) => { void track(pending); throw new Error('cuerpo'); })).rejects.toThrow('cuerpo');
      expect(settled).toBe(true);
      expect(failing.events.slice(-2)).toEqual(['rollback', 'release']);
      expect(failing.events).not.toContain('commit');
    });
    test('waitForWaiters: sondea hasta las esperas previstas y falla con plazo o con una observación inválida', async () => {
      const lock = startsLike(LOCK_INVITATION_BY_TOKEN_SQL);
      let time = 0; let polls = 0;
      const io = (rows: () => WaiterRow[]) => ({ appPids: async () => [10], query: async () => { polls++; return rows(); }, now: () => time, sleep: async (ms: number) => { time += ms; } });
      await expect(waitForWaiters(io(() => (polls < 3 ? [] : [waiter(10, [99], LOCK_INVITATION_BY_TOKEN_SQL)])), { blocker: 99, patterns: [lock] })).resolves.toBeUndefined();
      expect(polls).toBeGreaterThanOrEqual(3);
      await expect(waitForWaiters(io(() => []), { blocker: 99, patterns: [lock], deadlineMs: 100 })).rejects.toThrow('no se observaron a tiempo');
      await expect(waitForWaiters(io(() => [waiter(10, [99], 'SELECT 1')]), { blocker: 99, patterns: [lock] })).rejects.toThrow('espera inválida');
      await expect(waitForWaiters({ appPids: async () => [], query: async () => { throw new Error('no debe consultar'); }, now: () => time, sleep: async ms => { time += ms; } }, { blocker: 99, patterns: [lock], deadlineMs: 50 })).rejects.toThrow('a tiempo');
    });

    test('carreras con cualquier ganador válido: cada rama comprueba los efectos y la ausencia de restos del perdedor', () => {
      const http = read('http-acceptance.ts');
      expect(http.match(/if \(acceptance\.status === 201\) \{/g)).toHaveLength(3);
      for (const step of ['aceptar frente a revocar', 'aceptar frente a renovar', 'colisión de correo con un registro', 'colisión de correo entre dos aceptaciones', 'dos aceptaciones simultáneas']) expect(http).toContain(step);
      expect(http).toContain('await assertNothing(email, target.id, before);');
      expect(http).toContain("organization.length === 0");
      expect(http).toContain('await isOpen(won.other.id)');
    });
    test('los dos rollbacks: bloqueo en company_accesses y en user_sessions, sin liberar antes de la respuesta', () => {
      const http = read('http-acceptance.ts');
      const block = http.slice(http.indexOf('/* ---- 11 y 12.'), http.indexOf('/* ---- 13.'));
      expect(block).toContain('acceptanceLocks.accesses, accessInsert');
      expect(block).toContain('acceptanceLocks.sessions, sessionInsert');
      expect(block).toContain('await waitForWaiters(io, { blocker: pid, patterns: [pattern] });');
      expect(block).not.toContain('release()');
      expect(block).toContain('LOCK_WAIT.timeoutMinMs');
      expect(block).toContain('await assertNothing(email, target.id, before);');
      expect(block).toContain('const retried = await accept(target.token, name);');
    });
    test('el login posterior se distingue de la sesión de la aceptación', () => {
      const http = read('http-acceptance.ts');
      expect(http).toContain('const second = await login(acceptanceInvitee(id, 0));');
      expect(http).toContain('both.length === 2 && fromAcceptance.length === 1 && fromLogin.length === 1 && fromAcceptance[0].id !== fromLogin[0].id');
      expect(http).toContain('session.length === (options.sessions ?? 1) && mine.length === 1');
    });
    test('el salto de reloj es uno solo y va después de todo lo que necesita sesiones vigentes', () => {
      const http = read('http-acceptance.ts');
      expect(http.match(/clock\.(advance|set)\(/g)).toHaveLength(1);
      const jump = http.indexOf('clock.advance(2 * DAY)');
      for (const earlier of ['aceptación completa de worker y client', 'login posterior genera otra sesión', 'filtro accepted', 'colisión de correo entre dos aceptaciones', 'rollback en la sesión']) {
        expect(http.indexOf(earlier)).toBeGreaterThan(-1); expect(http.indexOf(earlier)).toBeLessThan(jump);
      }
      const after = http.slice(jump);
      expect(after).not.toContain('await login(');
      expect(after).toContain('secure(expiredList, { cookie: true })');
      expect(after.indexOf("step = 'logs sin secretos'")).toBeGreaterThan(0);
      expect(http.slice(0, jump)).toContain("await waitForWaiters(io, { blocker: pid, patterns: [acceptLock] }); // already past the early read, waiting at the lock");
    });

    describe('comandos finales', () => {
      const command = () => acceptanceRunCommand({ backend: '/ruta/backend' });
      test('dos zonas, DATABASE_POOL_MAX=10, salida distinta de cero al primer fallo y sin break', () => {
        expect([...ACCEPTANCE_ZONE_CELLS]).toEqual(['UTC', 'Pacific/Chatham']);
        for (const needle of ['set -e', 'cd "/ruta/backend" || exit 1', '. ./.env.test', 'AGENDA_B2B_PHASE=acceptance', 'DATABASE_POOL_MAX=10', 'LOG_LEVEL=info',
          'APP_ALLOWED_ORIGINS=https://app.agenda.test', '--runInBand test/pg/registration.pg.spec.ts', 'exit 1; }', '(exit $b2b_rc)', '\n  cell UTC\n', '\n  cell Pacific/Chatham\n']) expect(command()).toContain(needle);
        expect(command()).not.toMatch(/\bbreak\b|\|\| true|\bfor\b|\bwhile\b|set \+e|\bstatus=/);
        expect(command()).not.toMatch(/PASSWORD|DATABASE_(HOST|USER|NAME|PORT)/);
      });
      const shells = ['bash', 'zsh'].filter(shell => spawnSync(shell, ['-c', 'exit 0']).status === 0);
      test.each(shells)('%s: éxito = 0 con las dos zonas; un fallo detiene el resto y devuelve distinto de cero', shell => {
        const dir = mkdtempSync(join(tmpdir(), 'b2b-acc-'));
        const log = join(dir, 'log'), stub = join(dir, 'stub.sh');
        writeFileSync(stub, '#!/bin/sh\necho "$AGENDA_B2B_PHASE|$AGENDA_B2B_TIMEZONE|$DATABASE_POOL_MAX|$LOG_LEVEL|$APP_ALLOWED_ORIGINS|$NODE_ENV" >> "$STUB_LOG"\n[ "$AGENDA_B2B_TIMEZONE" = "$STUB_FAIL_ZONE" ] && exit 3\nexit 0\n');
        chmodSync(stub, 0o755);
        const text = acceptanceRunCommand({ backend: dir, jest: `sh ${stub}`, loadEnv: ':' });
        const run = (failZone: string) => {
          writeFileSync(log, '');
          const result = spawnSync(shell, ['-c', `${text}\nexit $?`], { env: { PATH: process.env.PATH ?? '', STUB_LOG: log, STUB_FAIL_ZONE: failZone }, encoding: 'utf8' });
          return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
        };
        const ok = run('ninguna');
        expect(ok.status).toBe(0);
        expect(ok.lines).toEqual(['acceptance|UTC|10|info|https://app.agenda.test|test', 'acceptance|Pacific/Chatham|10|info|https://app.agenda.test|test']);
        for (const [zone, executed] of [['UTC', 1], ['Pacific/Chatham', 2]] as const) {
          const failed = run(zone);
          expect(failed.status).not.toBe(0); expect(failed.lines).toHaveLength(executed);
          expect(failed.stderr).toContain(`FALLÓ: PostgreSQL=${zone}`); expect(failed.stdout).toContain('código de salida=1');
          expect(failed.stdout).not.toContain('todas las ejecuciones terminaron bien');
        }
      });
    });
  });
}
