import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { LINKED_ORGANIZATION_ID as linked, PLATFORM_ADMIN_ID } from '../src/platform/ids';
import { resolveDirectory, organizationDisplayName, reconcileWithDirectory } from '../src/platform/directory';
import { resolveAccess, accessForWorkspace, ACCESS_MESSAGES } from '../src/platform/access';
import { platformCan, PLATFORM_ACTIONS } from '../src/platform/permissions';
import { validateOrganization, validateReason, SIMULATED_INVITATION_NOTICE } from '../src/platform/validation';
import * as op from '../src/platform/operations';
import { restorePlatform } from '../src/platform/restore';
import type { AdminSession, PlatformState, Result } from '../src/platform/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
const input = { name: '  Nueva   organización ', managerName: '  María   Lagos ', email: ' MARIA@EXAMPLE.INVALID ' };
function value(result: Result): PlatformState { assert.ok(result.ok); return result.value; }

test('semilla, ids estables y directorio mínimo sin duplicar el espacio de trabajo', () => {
  const s = generatePlatformSeed(), w = generateDemo();
  assert.equal(s.organizations.length, 4);
  assert.equal(w.organization.id, linked);
  assert.equal(s.organizations[0].name, w.organization.name);
  assert.ok(!w.users.some(u => u.id === PLATFORM_ADMIN_ID));
  assert.ok(w.users.every(u => s.memberAccess.some(a => a.organizationId === linked && a.userId === u.id)));
  assert.ok(!s.members.some(m => m.organizationId === linked));
  assert.ok(!s.companies.some(c => w.companies.some(wc => wc.id === c.id)));
  assert.ok(s.members.every(m => m.example && /datos de ejemplo/.test(m.name)));
  assert.ok(s.companies.every(c => c.example));
  assert.deepEqual(resolveDirectory(s, w, linked), {
    companies: w.companies.map(({ id, name, color }) => ({ id, name, color })),
    members: w.users.map(({ id: userId, name, role, example }) => ({ userId, name, role, example })),
  });
  assert.equal(organizationDisplayName(s, { ...w, organization: { ...w.organization, name: 'Renombrada' } }, linked), 'Renombrada');
  assert.equal(resolveDirectory(s, w, 'example-org-0').members[0].email, s.members[0].email);
  assert.deepEqual(resolveDirectory(s, w, 'missing'), { companies: [], members: [] });
});

test('validación por campo: normalización, duplicados, formatos y límites', () => {
  const s = generatePlatformSeed();
  const result = validateOrganization(s, input);
  assert.ok(result.ok); assert.deepEqual(result.value, { name: 'Nueva organización', managerName: 'María Lagos', email: 'maria@example.invalid' });
  for (const name of [' ESTUDIO creativo ', 'Estúdio   Créativo']) {
    const r = validateOrganization(s, { ...input, name }); assert.ok(!r.ok); assert.equal(r.code, 'duplicate_name');
  }
  for (const [field, values] of Object.entries({ name: ['', 'a', 'a'.repeat(81)], managerName: ['', 'x', 'a'.repeat(81)], email: ['', 'bad', 'a@b', 'a b@c.cl', 'a'.repeat(110) + '@example.cl'] })) {
    for (const invalid of values) {
      const r = validateOrganization(s, { ...input, [field]: invalid }); assert.ok(!r.ok); assert.equal(r.code, 'invalid_input'); assert.equal(r.field, field); assert.ok(r.reason);
    }
  }
  assert.ok(validateOrganization(s, { ...input, name: 'a'.repeat(80), managerName: 'ab', email: 'a'.repeat(115) + '@b.cl' }).ok);
  for (const email of [s.members[0].email.toUpperCase(), ` ${s.members[0].email} `]) {
    const r = validateOrganization(s, { ...input, email }); assert.ok(!r.ok); assert.equal(r.code, 'duplicate_email');
  }
  assert.deepEqual(validateReason('   '), { ok: true, value: undefined });
  assert.deepEqual(validateReason('  Motivo  '), { ok: true, value: 'Motivo' });
  assert.ok(validateReason('a'.repeat(200)).ok); assert.ok(!validateReason('a'.repeat(201)).ok);
  assert.ok(!validateReason(5).ok); assert.ok(!validateOrganization(s, null).ok);
});

test('todas las operaciones y lecturas requieren su propia sesión sin mutar', () => {
  const s = generatePlatformSeed(), w = generateDemo(), snapshot = JSON.stringify(s);
  for (const session of [null, { kind: 'platform_admin', adminId: 'roger' } as AdminSession, { kind: 'community_manager' } as unknown as AdminSession]) {
    for (const action of PLATFORM_ACTIONS) assert.equal(platformCan(session, action), false);
    for (const result of [op.createOrganization(s, session, input), op.suspendOrganization(s, session, { organizationId: linked }),
      op.reactivateOrganization(s, session, { organizationId: linked }), op.suspendMember(s, session, { organizationId: linked, userId: 'ana' }),
      op.reactivateMember(s, session, { organizationId: linked, userId: 'ana' }), op.resetPlatform(s, session),
      op.viewOrganization(s, session, linked, w), op.listOrganizations(s, session, w)]) {
      assert.ok(!result.ok); assert.equal(result.code, 'no_admin_session'); assert.equal(JSON.stringify(s), snapshot);
    }
  }
  for (const action of PLATFORM_ACTIONS) assert.equal(platformCan(admin, action), true);
  assert.ok(op.viewOrganization(s, admin, linked, w).ok);
  assert.ok(!op.viewOrganization(s, admin, 'missing', w).ok);
});

test('creación sin credenciales ni acceso de trabajo; invitación exclusivamente simulada', () => {
  const w = generateDemo(), before = JSON.stringify(w), s = generatePlatformSeed();
  const created = value(op.createOrganization(s, admin, { ...input, password: 'x', secret: 'x', credentials: { token: 'x' } }, new Date('2026-10-20Z'), 'new-org'));
  assert.deepEqual(created.organizations.at(-1), { id: 'new-org', name: 'Nueva organización', status: 'active', workspaceLinked: false, createdAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(created.members.at(-1)?.role, 'community_manager');
  assert.deepEqual(created.members.at(-1)?.invitation, { simulated: true, createdAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(created.members.at(-1)?.example, false);
  assert.deepEqual(created.companies, s.companies);
  assert.equal(JSON.stringify(w), before);
  const checkKeys = (object: unknown) => { if (object && typeof object === 'object') for (const [key, v] of Object.entries(object)) { assert.doesNotMatch(key, /pass|contraseñ|secret|token|credential/i); checkKeys(v); } };
  checkKeys(JSON.parse(JSON.stringify(created)));
  assert.match(SIMULATED_INVITATION_NOTICE, /no se envía ningún correo/);
  assert.ok(created.organizations.filter(o => !o.workspaceLinked).every(o => o.id !== w.organization.id));
});

test('suspensiones independientes, datos conservados, no_change y errores controlados', () => {
  const s = generatePlatformSeed(), w = generateDemo(), before = JSON.stringify(w);
  const suspended = value(op.suspendOrganization(s, admin, { organizationId: ` ${linked} `, reason: '  Privado  ' }));
  assert.deepEqual(suspended.members, s.members); assert.deepEqual(suspended.companies, s.companies); assert.deepEqual(suspended.memberAccess, s.memberAccess);
  const member = value(op.suspendMember(suspended, admin, { organizationId: linked, userId: ' ana ', reason: 'Privado individual' }));
  const reactivated = value(op.reactivateOrganization(member, admin, { organizationId: linked }));
  assert.deepEqual(reactivated.memberAccess, member.memberAccess);
  assert.deepEqual(resolveAccess(reactivated, linked, 'ana'), { allowed: false, code: 'member_suspended' });
  const restored = value(op.reactivateMember(reactivated, admin, { organizationId: linked, userId: 'ana' }));
  assert.deepEqual(resolveAccess(restored, linked, 'ana'), { allowed: true });
  for (const result of [op.suspendOrganization(suspended, admin, { organizationId: linked }), op.reactivateOrganization(s, admin, { organizationId: linked }),
    op.suspendMember(member, admin, { organizationId: linked, userId: 'ana' }), op.reactivateMember(s, admin, { organizationId: linked, userId: 'ana' })]) {
    assert.ok(!result.ok); assert.equal(result.code, 'no_change');
  }
  const unknown = op.suspendMember(s, admin, { organizationId: linked, userId: 'missing' }); assert.ok(!unknown.ok); assert.equal(unknown.code, 'unknown_member');
  const missing = op.suspendOrganization(s, admin, { organizationId: 'missing' }); assert.ok(!missing.ok); assert.equal(missing.code, 'not_found');
  assert.ok(!op.suspendOrganization(s, admin, { organizationId: linked, reason: 'a'.repeat(201) }).ok);
  assert.equal(JSON.stringify(w), before);
});

test('matriz completa de acceso y ausencia de motivos en el contrato del espacio de trabajo', () => {
  for (const known of [true, false]) for (const orgStatus of ['active', 'suspended'] as const) for (const memberStatus of ['active', 'suspended'] as const) {
    const s = generatePlatformSeed(); s.organizations[0].status = orgStatus; s.organizations[0].suspension = { at: '2026-01-01Z', reason: 'PRIVADO' };
    s.memberAccess[0].status = memberStatus; s.memberAccess[0].suspension = { at: '2026-01-01Z', reason: 'PRIVADO' };
    const expected = !known ? 'organization_unknown' : orgStatus === 'suspended' ? 'organization_suspended' : memberStatus === 'suspended' ? 'member_suspended' : undefined;
    const result = accessForWorkspace(s, known ? linked : 'missing', s.memberAccess[0].userId);
    assert.deepEqual(result, expected ? { allowed: false, code: expected } : { allowed: true });
    assert.doesNotMatch(JSON.stringify(result), /reason|PRIVADO/);
    if (expected) assert.ok(ACCESS_MESSAGES[expected]);
  }
  assert.notEqual(ACCESS_MESSAGES.organization_suspended, ACCESS_MESSAGES.member_suspended);
});

test('restauración sanea huérfanos y extras, conserva suspensiones y falla cerrado si falta el vínculo', () => {
  const s = value(op.suspendOrganization(generatePlatformSeed(), admin, { organizationId: linked, reason: 'Conservar' }));
  const dirty = structuredClone(s);
  dirty.members.push({ ...dirty.members[0], id: 'orphan', organizationId: 'absent' });
  dirty.companies.push({ ...dirty.companies[0], id: 'orphan', organizationId: 'absent' });
  dirty.memberAccess.push({ organizationId: 'absent', userId: 'orphan', status: 'active' });
  assert.deepEqual(restorePlatform(JSON.stringify({ ...dirty, password: 'remove' })), s);
  const withoutLinked = { ...s, organizations: s.organizations.filter(o => o.id !== linked) };
  const restored = restorePlatform(JSON.stringify(withoutLinked));
  assert.deepEqual(resolveAccess(restored, linked, 'ana'), { allowed: false, code: 'organization_unknown' });
  assert.ok(!restored.memberAccess.some(a => a.organizationId === linked));
  assert.ok(value(op.resetPlatform(restored, admin)).organizations.some(o => o.id === linked));
  const reconciled = reconcileWithDirectory(s, ['ana']);
  assert.deepEqual(reconciled.memberAccess.filter(a => a.organizationId === linked).map(a => a.userId), ['ana']);
  assert.deepEqual(reconciled.memberAccess.filter(a => a.organizationId !== linked), s.memberAccess.filter(a => a.organizationId !== linked));
  for (const raw of ['{', 'null', '{}', JSON.stringify({ ...s, version: 2 }), JSON.stringify({ ...s, revision: -1 }), JSON.stringify({ ...s, organizations: [{}] })]) assert.deepEqual(restorePlatform(raw), generatePlatformSeed());
});

test('plataforma no lee contenido; roles y tabla de permisos del espacio de trabajo permanecen separados', () => {
  function inspect(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { inspect(url); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = readFileSync(url, 'utf8');
      assert.doesNotMatch(source, /\b(?:posts|comments|attachments)\b|import.*(?:data\/demo|store\/selectors|features\/workspace|features\/posts|\.\.\/workspace)/, url.pathname);
      if (url.pathname.includes('/features/platform/') || url.pathname.includes('/auth/')) {
        assert.doesNotMatch(source, /(?:href|to)\s*[:=]\s*[{'"`]*\/empresa/, url.pathname);
      }
      if (url.pathname.includes('/features/platform/')) {
        assert.doesNotMatch(source, /localStorage|['"](?:[^'"]*\/)?platform\/operations['"]|\/empresa/, url.pathname);
      }
    }
  }
  for (const directory of ['platform/', 'auth/', 'features/platform/']) inspect(new URL(`../src/${directory}`, import.meta.url));
  const profile = readFileSync(new URL('../src/features/workspace/DemoMode.tsx', import.meta.url), 'utf8');
  assert.deepEqual([...profile.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['community_manager', 'worker', 'client']);
  assert.doesNotMatch(profile, /platform_admin|platform-admin/);
  const types = readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf8');
  assert.match(types, /export type Role = 'community_manager' \| 'worker' \| 'client';/);
  const rules = readFileSync(new URL('../src/store/permissions.ts', import.meta.url), 'utf8');
  // viewOrganization ya era una acción del espacio de trabajo antes de este bloque.
  for (const action of PLATFORM_ACTIONS.filter(a => a !== 'viewOrganization')) assert.ok(!rules.includes(action));
  assert.doesNotMatch(rules, /platform_admin|platform-admin/);
});
