import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { organizationDetailId, PLATFORM_NAVIGATION } from '../src/platform/routes';
import { resolveRoute } from '../src/auth/routeGuard';
import { accessCauses, accessCauseLabel, resolveAccess, accessForWorkspace } from '../src/platform/access';
import { formatOrganizationDate, memberConfirmation, organizationConfirmation, individuallySuspendedCount, organizationsReturnUrl } from '../src/features/platform/detailLogic';
import { generatePlatformSeed } from '../src/platform/seed';
import { generateDemo } from '../src/data/demo';
import { viewOrganization } from '../src/platform/operations';
import { createPlatformStore } from '../src/platform/store';
import { restorePlatform } from '../src/platform/restore';
import { LINKED_ORGANIZATION_ID as linked, PLATFORM_ADMIN_ID } from '../src/platform/ids';
import type { AdminSession, Result } from '../src/platform/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
const input = { organizationId: linked, userId: 'ana', reason: '  Motivo privado  ' };
function success(result: Result) { assert.ok(result.ok); return result.value; }
function fixture(session: AdminSession | null = admin) {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const store = createPlatformStore(storage, { getSession: () => session });
  return { store, storage };
}
for (const id of ['org-1', 'A_b-9', 'x'.repeat(80)]) for (const trailing of ['', '/']) {
  test(`detalle válido ${id} barra ${!!trailing}`, () => {
    const path = `/plataforma/organizaciones/${id}${trailing}`;
    assert.equal(organizationDetailId(path), id);
    assert.deepEqual(resolveRoute('none', path), { view: 'login', redirectTo: '/' });
    assert.deepEqual(resolveRoute('workspace', path), { view: 'workspace', redirectTo: '/empresas' });
    assert.deepEqual(resolveRoute('platform_admin', path), { view: 'platform' });
  });
}
test('rutas desconocidas se quedan en 404 interna; patrón seguro y navegación sin entradas nuevas', () => {
  for (const suffix of ['x/y', 'x//', 'á', '%20', 'x.y', '..', 'a b', 'x'.repeat(81), '']) {
    const path = `/plataforma/organizaciones/${suffix}`;
    assert.equal(organizationDetailId(path), null);
    assert.deepEqual(resolveRoute('platform_admin', path), { view: 'platform' });
  }
  assert.equal(organizationDetailId('/plataforma/Organizaciones/x'), null);
  assert.equal(organizationDetailId('/PLATAFORMA/organizaciones/x'), null);
  assert.deepEqual(PLATFORM_NAVIGATION.map(n => n.label), ['Panel', 'Organizaciones']);
});
test('vuelta al listado conserva solo búsqueda y filtro saneados, incluso al entrar directamente', () => {
  assert.equal(organizationsReturnUrl('?q=María+%26+Socios&estado=suspendidas&return=https://otro.invalid'), '/plataforma/organizaciones?q=Mar%C3%ADa+%26+Socios&estado=suspendidas');
  assert.equal(organizationsReturnUrl('?estado=invalid'), '/plataforma/organizaciones');
  assert.equal(organizationsReturnUrl(''), '/plataforma/organizaciones');
});
for (const organizationSuspended of [false, true]) for (const memberSuspended of [false, true]) {
  test(`causas: organización ${organizationSuspended}, miembro ${memberSuspended}`, () => {
    const s = generatePlatformSeed();
    s.organizations[0].status = organizationSuspended ? 'suspended' : 'active';
    s.organizations[0].suspension = { at: '2026-01-01', reason: 'SECRETO' };
    const access = s.memberAccess.find(a => a.userId === 'ana')!;
    access.status = memberSuspended ? 'suspended' : 'active';
    access.suspension = { at: '2026-01-01', reason: 'SECRETO' };
    const causes = accessCauses(s, linked, 'ana');
    assert.deepEqual(causes, { allowed: !organizationSuspended && !memberSuspended, organizationSuspended, memberSuspended });
    assert.equal(resolveAccess(s, linked, 'ana').allowed, causes.allowed);
    assert.deepEqual(accessForWorkspace(s, linked, 'ana'), resolveAccess(s, linked, 'ana'));
    assert.doesNotMatch(JSON.stringify(accessForWorkspace(s, linked, 'ana')), /reason|suspension|SECRETO/);
    assert.equal(accessCauseLabel(causes), organizationSuspended ? memberSuspended ? 'Bloqueado por ambas causas' : 'Bloqueado por la organización' : memberSuspended ? 'Bloqueado individualmente' : 'Permitido');
  });
}
test('organización inexistente falla cerrado sin inventar causas', () => {
  assert.deepEqual(accessCauses(generatePlatformSeed(), 'unknown', 'ana'), { allowed: false, organizationSuspended: false, memberSuspended: false });
});
for (const total of [0, 1, 2]) for (const suspended of [0, 1, 2]) {
  test(`confirmaciones organización N=${total} K=${suspended}`, () => {
    const name = 'Estudio «A» "B"';
    const suspend = organizationConfirmation(name, true, total, suspended);
    assert.ok(suspend.includes(`«${name}»`));
    assert.ok(suspend.includes(total === 1 ? 'su 1 miembro quedará bloqueado' : `sus ${total} miembros quedarán bloqueados`));
    assert.match(suspend, /Los accesos individuales no cambian y los datos ya guardados se conservan\./);
    assert.equal(suspend.includes('ya tiene'), total > 0);
    if (total) assert.ok(suspend.includes(suspended === 1 ? '1 miembro ya tiene' : `${suspended} miembros ya tienen`));
    const activate = organizationConfirmation(name, false, total, suspended);
    assert.equal(activate.includes('salvo'), suspended > 0);
    if (suspended) assert.ok(activate.includes(suspended === 1 ? 'el 1 que tiene' : `los ${suspended} que tienen`));
  });
}
for (const suspend of [true, false]) for (const blocked of [true, false]) {
  test(`confirmación miembro suspensión ${suspend} organización bloqueada ${blocked}`, () => {
    const text = memberConfirmation('Ana «A» "B"', 'Org «C»', suspend, blocked);
    assert.ok(text.includes('«Ana «A» "B"»'));
    assert.ok(text.includes('«Org «C»»'));
    assert.equal(text.includes('bloqueado por la organización'), blocked);
    if (suspend) assert.match(text, /No afecta a los demás miembros ni a otras organizaciones, y sus datos ya guardados se conservan/);
    else assert.match(text, /recupera su acceso individual/);
  });
}
test('detalle vinculado por referencia y no vinculado; desconocido y desaparecido tras reset', () => {
  const { store } = fixture();
  try {
    const w = generateDemo(); w.organization.name = 'Nombre actual';
    const before = JSON.stringify(store.getState());
    const result = store.viewOrganization(linked, w); assert.ok(result.ok);
    assert.equal(result.value.organization.name, 'Nombre actual');
    assert.deepEqual(result.value.directory.companies.map(c => c.id), w.companies.map(c => c.id));
    assert.deepEqual(result.value.directory.members.map(m => m.userId), w.users.map(u => u.id));
    assert.equal(JSON.stringify(store.getState()), before);
    assert.ok(!store.getState().members.some(m => m.organizationId === linked));
    assert.ok(!store.getState().companies.some(c => c.organizationId === linked));
    const example = store.viewOrganization('example-org-0', w); assert.ok(example.ok);
    assert.equal(example.value.directory.members[0].userId, 'example-member-0');
    assert.equal(example.value.directory.companies[0].id, 'example-company-0');
    const created = success(store.createOrganization({ name: 'Organización nueva', managerName: 'María', email: 'maria@test.cl' }));
    const id = created.organizations.at(-1)!.id;
    const detail = store.viewOrganization(id, w); assert.ok(detail.ok);
    assert.deepEqual(detail.value.directory.companies, []);
    assert.equal(detail.value.directory.members.length, 1);
    store.resetPlatform();
    for (const missing of [id, 'unknown']) {
      const absent = viewOrganization(store.getState(), admin, missing, w); assert.ok(!absent.ok); assert.equal(absent.code, 'not_found');
    }
  } finally { store.dispose(); }
});
test('las cuatro escrituras sin sesión no alteran estado ni revisión', () => {
  const { store, storage } = fixture(null);
  try {
    const before = store.getState();
    for (const action of [store.suspendOrganization, store.reactivateOrganization, store.suspendMember, store.reactivateMember]) {
      const result = action(input); assert.ok(!result.ok); assert.equal(result.code, 'no_admin_session');
      assert.equal(store.getState(), before); assert.equal(store.getState().revision, before.revision); assert.equal(storage.getItem(), null);
    }
  } finally { store.dispose(); }
});
test('conservación exacta, contador K, persistencia y códigos de las cuatro operaciones', () => {
  const { store, storage } = fixture();
  try {
    const before = store.getState();
    const suspended = success(store.suspendOrganization(input));
    assert.deepEqual({ ...suspended, revision: before.revision, organizations: before.organizations }, before);
    assert.deepEqual(suspended.organizations.slice(1), before.organizations.slice(1));
    assert.deepEqual({ ...suspended.organizations[0], status: 'active', suspension: undefined }, { ...before.organizations[0], suspension: undefined });
    const member = success(store.suspendMember(input));
    assert.deepEqual({ ...member, revision: suspended.revision, memberAccess: suspended.memberAccess }, suspended);
    assert.deepEqual(member.memberAccess.map(a => a.userId), suspended.memberAccess.map(a => a.userId));
    assert.deepEqual(member.memberAccess.filter(a => a.userId !== 'ana'), suspended.memberAccess.filter(a => a.userId !== 'ana'));
    assert.deepEqual(restorePlatform(storage.getItem()), member);
    assert.equal(member.memberAccess.find(a => a.userId === 'ana')!.suspension!.reason, 'Motivo privado');
    for (const action of [store.suspendOrganization, store.suspendMember]) {
      const result = action(input); assert.ok(!result.ok); assert.equal(result.code, 'no_change'); assert.equal(store.getState(), member);
    }
    const restored = success(store.reactivateOrganization(input));
    assert.deepEqual(restored.memberAccess, member.memberAccess);
    const k = individuallySuspendedCount(restored, linked, generateDemo().users.map(u => u.id));
    assert.equal(k, 1); assert.match(organizationConfirmation('Org', false, 4, k), /salvo el 1/);
    const active = success(store.reactivateMember(input));
    assert.deepEqual({ ...active, revision: restored.revision, memberAccess: restored.memberAccess }, restored);
    assert.equal(active.memberAccess.find(a => a.userId === 'ana')!.suspension, undefined);
    for (const action of [store.reactivateOrganization, store.reactivateMember]) {
      const result = action(input); assert.ok(!result.ok); assert.equal(result.code, 'no_change'); assert.equal(store.getState(), active);
    }
    for (const action of [store.suspendOrganization, store.reactivateOrganization, store.suspendMember, store.reactivateMember]) {
      const result = action({ ...input, organizationId: 'unknown' }); assert.ok(!result.ok); assert.equal(result.code, 'not_found'); assert.equal(store.getState(), active);
    }
    for (const action of [store.suspendMember, store.reactivateMember]) {
      const result = action({ ...input, userId: 'unknown' }); assert.ok(!result.ok); assert.equal(result.code, 'unknown_member'); assert.equal(store.getState(), active);
    }
  } finally { store.dispose(); }
});
test('contador K incluye solo miembros del directorio actual y cuenta 0/1/2', () => {
  const { store } = fixture();
  try {
    for (const [index, userId] of ['ana', 'pablo'].entries()) {
      assert.equal(individuallySuspendedCount(store.getState(), linked, ['ana', 'pablo']), index);
      store.suspendMember({ organizationId: linked, userId });
    }
    assert.equal(individuallySuspendedCount(store.getState(), linked, ['ana', 'pablo']), 2);
    assert.equal(individuallySuspendedCount(store.getState(), linked, ['ana']), 1);
  } finally { store.dispose(); }
});
test('pérdida de almacenamiento se anuncia y elimina la organización creada', () => {
  const { store, storage } = fixture();
  try {
    const created = success(store.createOrganization({ name: 'Nueva', managerName: 'Ana', email: 'ana@test.cl' })).organizations.at(-1)!;
    storage.setItem('', 'null'); store.refresh();
    assert.ok(!store.getState().organizations.some(o => o.id === created.id));
    storage.setItem('', JSON.stringify(store.getState())); store.refresh();
    // Simula removeItem sin añadir métodos al almacenamiento productivo.
    storage.getItem = () => null; store.refresh();
    assert.match(store.getStorageWarning(), /Se perdió/);
  } finally { store.dispose(); }
});
test('motivos de plataforma restringidos y sin enlaces al espacio de trabajo, recursivo', () => {
  function inspect(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { inspect(url); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = readFileSync(url, 'utf8');
      if (/\/features\/platform\//.test(url.pathname)) {
        assert.doesNotMatch(source, /\/empresa|localStorage|from ['"][^'"]*platform\/operations/);
      } else if (!/\/platform\//.test(url.pathname)) {
        assert.doesNotMatch(source, /\bsuspension\b|\bSuspension\b|\bPlatformState\b|\bPlatformOrganization\b|\bMemberAccess\b/);
        // Solo App y el almacén conectan la suscripción/guarda; no leen metadatos privados.
        if (/\/src\/(?:App\.tsx|store\/index\.ts)$/.test(url.pathname)) {
          assert.doesNotMatch(source, /platform\.(?:organizations|memberAccess)|\.suspension|\.reason/);
          continue;
        }
        assert.doesNotMatch(source, /from ['"][^'"]*platform\/(?:store|operations|directory|restore|seed|validation)['"]/);
        assert.doesNotMatch(source, /import\(['"][^'"]*platform\/(?:store|operations|directory|restore|seed|validation)['"]\)/);
      }
    }
  }
  inspect(new URL('../src/', import.meta.url));
});

test('fechas de toda la semilla conservan el 1 de enero en Santiago; detalle usa esa zona', () => {
  const seed = generatePlatformSeed();
  const dates = [
    ...seed.organizations.map(o => o.createdAt),
    ...seed.organizations.flatMap(o => o.suspension ? [o.suspension.at] : []),
    ...seed.memberAccess.flatMap(a => a.suspension ? [a.suspension.at] : []),
  ];
  for (const value of dates) {
    assert.equal(value, '2026-01-01T15:00:00.000Z');
    assert.equal(formatOrganizationDate(value), '1 de enero de 2026');
  }
  // El instante antiguo sigue representando el día anterior: no hay migración.
  assert.equal(formatOrganizationDate('2026-01-01T00:00:00.000Z'), '31 de diciembre de 2025');
  const saved = structuredClone(seed);
  saved.organizations[0].createdAt = '2026-01-01T00:00:00.000Z';
  assert.equal(restorePlatform(JSON.stringify(saved)).organizations[0].createdAt, saved.organizations[0].createdAt);
  const source = readFileSync(new URL('../src/features/platform/OrganizationDetail.tsx', import.meta.url), 'utf8');
  assert.match(source, /formatOrganizationDate\(organization.createdAt\)/);
});
