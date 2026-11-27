import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUMP_MEMBER_VERSION_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LOCK_MEMBER_SQL } from '../../../src/members/member-sql';
import { invitationsCleanupByIdSQL, invitationsCleanupSQL } from './invitations-fixture';
import { matchWaiters, startsLike, type WaiterRow } from './lock-support';
import { DeleteGate } from './markers';
import { DEACTIVATE_MEMBER_SQL, membersCleanupTargets, membersInvitee, membersLocks, membersMarkers, membersRunCommand, membersSQL, MEMBERS_INVITEES, MEMBERS_ZONE } from './members-fixture';
import { MEMBERS_TIME_ZONES, parseMembersTimeZone, parsePhase, phaseEnvironment } from './phase';

const ID = 'abcdef012345';
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const waiter = (pid: number, blockers: number[], query: string): WaiterRow => ({ pid, wait_event_type: 'Lock', wait_event: 'relation', blockers, query });

export function registerMembersOfflineTests(): void {
  describe('members offline', () => {
    test('fase seleccionable y solo UTC', () => {
      expect(parsePhase('members', 'test')).toBe('members');
      expect([...MEMBERS_TIME_ZONES]).toEqual(['UTC']);
      expect(MEMBERS_ZONE).toBe('UTC');
      expect(phaseEnvironment('members', { PGOPTIONS: 'x', AGENDA_B2B_TIMEZONE: 'UTC' }).PGOPTIONS).toBe('-c TimeZone=UTC');
      for (const bad of [undefined, '', 'Pacific/Chatham', 'America/Santiago', 'utc', 'UTC ', 'UTC; DROP']) {
        expect(() => parseMembersTimeZone(bad)).toThrow('fase members');
        expect(() => phaseEnvironment('members', { AGENDA_B2B_TIMEZONE: bad as string })).toThrow('fase members');
      }
      for (const other of ['Members', 'member', 'members ']) expect(() => parsePhase(other, 'test')).toThrow('AGENDA_B2B_PHASE');
    });
    test('el gate se arma solo con identidad, esquema y línea base', () => {
      for (const missing of ['identity', 'schema', 'baseline'] as const) {
        const gate = new DeleteGate('members');
        for (const check of ['identity', 'schema', 'baseline'] as const) if (check !== missing) gate.mark(check);
        expect(() => gate.arm()).toThrow();
        gate.mark(missing); gate.arm(); expect(() => gate.assertArmed()).not.toThrow();
      }
    });
    test('reservas completas antes de escribir y limpieza por esos marcadores', () => {
      const m = membersMarkers(ID), t = membersCleanupTargets(ID);
      expect(t.emails).toEqual([m.cmA.email, m.cmB.email, ...m.invitees]);
      expect(t.organizationNames).toEqual([m.cmA.organizationName, m.cmB.organizationName]);
      expect(new Set(t.emails).size).toBe(2 + MEMBERS_INVITEES);
      for (const email of t.emails) expect(email).toMatch(/^b2b-abcdef012345-[67]\d\d@agenda-b2b\.test$/);
      for (const bad of [-1, MEMBERS_INVITEES, 1.5]) expect(() => membersInvitee(ID, bad)).toThrow('fuera de las reservas');
      expect(code('http-members.ts')).toContain('const email = membersInvitee(id, n);');
    });

    test('la única modificación manual: parametrizada, sin tocar version, y acotada a la organización', () => {
      expect(DEACTIVATE_MEMBER_SQL).toBe('UPDATE public.organization_memberships SET deactivated_at = $2, updated_at = $2 WHERE id = $1 AND organization_id = $3 RETURNING id');
      expect(DEACTIVATE_MEMBER_SQL).not.toMatch(/version|role|'/);
      const http = code('http-members.ts');
      expect(http.match(/DEACTIVATE_MEMBER_SQL/g)).toHaveLength(2); // import and the single execution
      expect(http.match(/observer\.query\(DEACTIVATE_MEMBER_SQL/g)).toHaveLength(1);
      expect(http).toContain('expect(seeded.memberships.includes(client.id) && beforeOff.membership.organization_id === orgs.A && beforeOff.membership.deactivated_at === null).toBe(true);');
      expect(http).toContain('const [updated, affected] = await observer.query(DEACTIVATE_MEMBER_SQL, [client.id, clock.now(), orgs.A]) as [{ id: string }[], number];');
      expect(http).toContain('expect(affected === 1 && updated.length === 1 && updated[0].id === client.id).toBe(true);');
      expect(http).toContain('off.membership.version === beforeOff.membership.version');
      // The execution comes after the guard that checks the membership belongs to this run.
      expect(http.indexOf('seeded.memberships.includes(client.id)')).toBeLessThan(http.indexOf('observer.query(DEACTIVATE_MEMBER_SQL'));
    });
    test('el observador solo lee, el locker solo bloquea y no hay otras escrituras', () => {
      for (const sql of Object.values(membersSQL)) { expect(sql).toMatch(/^SELECT /); expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/); }
      expect(membersLocks.row).toBe('SELECT id FROM public.organization_memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE');
      for (const sql of [membersLocks.memberships, membersLocks.accesses]) expect(sql).toMatch(/^LOCK TABLE public\.(organization_memberships|company_accesses) IN SHARE MODE$/);
      const http = code('http-members.ts');
      const calls = [...http.matchAll(/\b(observer|locker|source)\.query\(([A-Za-z_.]+)/g)].map(m => m[2]);
      expect(calls.length).toBeGreaterThan(6);
      for (const argument of calls) expect(argument).toMatch(/^(SQL\.|invitationsSQL\.|DEACTIVATE_MEMBER_SQL$|sql$)/);
      expect(http).not.toMatch(/(INSERT INTO|DELETE FROM|UPDATE public)/);
      expect(code('members-fixture.ts').match(/UPDATE public/g)).toHaveLength(1);
      expect(code('members-fixture.ts')).not.toMatch(/INSERT INTO|DELETE FROM|commitTransaction/);
      expect(http).not.toContain('commitTransaction');
    });
    test('limpieza por ids y marcadores, de hijos a padres, con las diez tablas vacías', () => {
      const source = read('connected.ts');
      const body = source.slice(source.indexOf('async function cleanupMembers('), source.indexOf('Acceptance phase: exact ids first'));
      expect([...body.matchAll(/invitationsCleanupByIdSQL\.(\w+)/g)].map(m => m[1])).toEqual(Object.keys(invitationsCleanupByIdSQL));
      expect([...body.matchAll(/invitationsCleanupSQL\.(\w+)/g)].map(m => m[1])).toEqual(Object.keys(invitationsCleanupSQL));
      expect(body).toContain('await empty();');
      expect(source).toContain('it does NOT survive a forced termination of the process.\n     */\n    async function cleanupMembers(');
      expect(source).toContain('if (membersTargets) { await cleanupMembers(userIds, orgIds); return; }');
    });
    test('cableado: zona, locker, reloj controlado, logger con captura y registro', () => {
      const connected = read('connected.ts');
      for (const needle of ["if (phase === 'members') assertAuthOrigin(process.env.APP_ALLOWED_ORIGINS);", 'parseMembersTimeZone(process.env.AGENDA_B2B_TIMEZONE)',
        "if (phase === 'members') {\n          logCapture.reset();", "} else if (phase === 'members') {\n          // Controlled clock",
        "} else if (phase === 'members') {\n      afterAll(async () => { try { if (gate.isArmed && observer?.isInitialized) await cleanup(); } finally { await close(); } });",
        "if (phase === 'members') registerMembersTest("]) expect(connected).toContain(needle);
      expect(read('load-connected.cjs')).toContain("| 'members'");
      const http = read('http-members.ts');
      expect(http).toContain("formatAuthFailure(step, error, 'members')");
      expect(http).toContain('Array.from({ length: 8 }, () => source.query(invitationsSQL.poolTimeZone)');
      expect(http).toContain("['info', 'debug', 'trace'].includes(app.get(AppConfigService).logLevel)");
      for (const line of http.split('\n').filter(l => l.includes('console.'))) expect(line).not.toMatch(/token|PASSWORD|cookie|csrf|email|\.name\b|people/i);
    });

    test('las esperas distinguen el bloqueo, el borrado y la subida de versión', () => {
      const lock = startsLike(LOCK_MEMBER_SQL), bump = startsLike(BUMP_MEMBER_VERSION_SQL), del = startsLike(DELETE_ACCESSES_SQL);
      for (const [pattern, sql] of [[lock, LOCK_MEMBER_SQL], [bump, BUMP_MEMBER_VERSION_SQL], [del, DELETE_ACCESSES_SQL]] as const) {
        for (const other of [LOCK_MEMBER_SQL, BUMP_MEMBER_VERSION_SQL, DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL]) expect(pattern.test(other)).toBe(other === sql);
      }
      const options = { locker: 99, own: [10], patterns: [bump] };
      expect(matchWaiters([waiter(10, [99], BUMP_MEMBER_VERSION_SQL)], options)).toEqual({ state: 'ready' });
      // Waiting anywhere else (before or at the access writes) does not prove it reached the version update.
      for (const elsewhere of [DELETE_ACCESSES_SQL, INSERT_ACCESSES_SQL, LOCK_MEMBER_SQL]) expect(matchWaiters([waiter(10, [99], elsewhere)], options).state).toBe('invalid');
      expect(matchWaiters([waiter(10, [500], BUMP_MEMBER_VERSION_SQL)], options).state).toBe('invalid');
      expect(matchWaiters([waiter(11, [99], BUMP_MEMBER_VERSION_SQL)], options).state).toBe('waiting');
    });
    test('los dos rollbacks: sin liberar, bloqueados en la sentencia exacta, con instantánea completa y reintento manual', () => {
      const http = read('http-members.ts');
      const last = http.slice(http.indexOf('/* ---- 7. rollback en el último paso'), http.indexOf('/* ---- 8.'));
      expect(last).toContain('{ sql: membersLocks.memberships }');
      expect(last).toContain('await waitForWaiters(io, { blocker: pid, patterns: [bumpVersion] });');
      expect(last).toContain('expect(same(await snapshot(client.id), base7)).toBe(true);');
      expect(last).toContain("const retried7 = await put('cmA', client.id, 1, [A[0], A[1]]);");
      expect(last).not.toContain('release()');
      // The change removes and adds accesses, so both writes run before the version update.
      expect(last).toContain('companiesOf(base7) === A[2]');
      expect(last).toContain("track(put('cmA', client.id, 1, [A[0], A[1]]))");
      const firstWrite = http.slice(http.indexOf('/* ---- 8. rollback en la primera escritura'), http.indexOf('/* ---- 9.'));
      expect(firstWrite).toContain('{ sql: membersLocks.accesses }');
      expect(firstWrite).toContain('patterns: [deleteAccesses]');
      expect(firstWrite).toContain('expect(same(await snapshot(client.id), base8)).toBe(true);');
      expect(firstWrite).not.toContain('release()');
      // A complete snapshot: membership row (version, updated_at) and every access with its own created_at.
      expect(membersSQL.membership).toContain('version, deactivated_at::text AS deactivated_at, created_at::text AS created_at, updated_at::text AS updated_at');
      expect(membersSQL.accesses).toContain('company_id, organization_id, membership_role, created_at::text AS created_at');
      expect(http).toContain('const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);');
    });
    test('el resto de escenarios están: miembros reales, concurrencia, idéntico, retirada, aislamiento y roles', () => {
      const http = read('http-members.ts');
      for (const needle of ["post('/api/v1/invitations/accept')", 'expect(same(await snapshot(worker.id), after2)).toBe(true);', "[first.status, second.status].sort().join() === '200,409'",
        'patterns: [lockMember, lockMember]', "expect(await visible(worker) === '').toBe(true);", "stillIn.status === 200", 'same(await snapshot(outsider.id), snapshotB)', "'member_not_assignable'",
        "'member_deactivated'", 'lockedOut.status === 401', 'log.length > 0']) expect(http).toContain(needle);
      expect(http).not.toMatch(/INSERT INTO public\.(users|organization_memberships)/);
    });

    describe('comandos finales', () => {
      test('members en UTC y después readonly, con DATABASE_POOL_MAX=10 y parada al primer fallo', () => {
        const command = membersRunCommand({ backend: '/ruta/backend' });
        for (const needle of ['set -e', 'cd "/ruta/backend" || exit 1', '. ./.env.test', 'AGENDA_B2B_PHASE=members AGENDA_B2B_TIMEZONE=UTC', 'AGENDA_B2B_PHASE=readonly',
          'LOG_LEVEL=info', 'APP_ALLOWED_ORIGINS=https://app.agenda.test', 'exit 1; }', '(exit $b2b_rc)']) expect(command).toContain(needle);
        expect(command.match(/DATABASE_POOL_MAX=10/g)).toHaveLength(2);
        expect(command).not.toMatch(/\bbreak\b|\|\| true|set \+e|\bstatus=|PASSWORD/);
        expect(command.indexOf('AGENDA_B2B_PHASE=members')).toBeLessThan(command.indexOf('AGENDA_B2B_PHASE=readonly'));
      });
      const shells = ['bash', 'zsh'].filter(shell => spawnSync(shell, ['-c', 'exit 0']).status === 0);
      test.each(shells)('%s: éxito = 0 con las dos ejecuciones; un fallo detiene y devuelve distinto de cero', shell => {
        const dir = mkdtempSync(join(tmpdir(), 'b2b-mem-'));
        const log = join(dir, 'log'), stub = join(dir, 'stub.sh');
        writeFileSync(stub, '#!/bin/sh\necho "$AGENDA_B2B_PHASE|${AGENDA_B2B_TIMEZONE-sin zona}|$DATABASE_POOL_MAX|$NODE_ENV" >> "$STUB_LOG"\n[ "$AGENDA_B2B_PHASE" = "$STUB_FAIL" ] && exit 3\nexit 0\n');
        chmodSync(stub, 0o755);
        const text = membersRunCommand({ backend: dir, jest: `sh ${stub}`, loadEnv: ':' });
        const run = (fail: string) => {
          writeFileSync(log, '');
          const result = spawnSync(shell, ['-c', `${text}\nexit $?`], { env: { PATH: process.env.PATH ?? '', STUB_LOG: log, STUB_FAIL: fail }, encoding: 'utf8' });
          return { status: result.status, stdout: result.stdout, lines: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
        };
        const ok = run('ninguna');
        expect(ok.status).toBe(0);
        expect(ok.lines).toEqual(['members|UTC|10|test', 'readonly|sin zona|10|test']);
        const first = run('members');
        expect(first.status).not.toBe(0); expect(first.lines).toHaveLength(1); expect(first.stdout).toContain('código de salida=1');
        const second = run('readonly');
        expect(second.status).not.toBe(0); expect(second.lines).toHaveLength(2); expect(second.stdout).not.toContain('todo terminó bien');
      });
    });
  });
}
