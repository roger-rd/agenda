import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy } from '../src/platform/access';
import { workspaceDirectory } from '../src/platform/directory';
import { createPlatformStore, PLATFORM_KEY } from '../src/platform/store';
import { PLATFORM_ADMIN_ID } from '../src/platform/ids';
import { validateOrganization, validateOrganizationField } from '../src/platform/validation';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { can } from '../src/store/permissions';
import type { Result, WorkspaceError } from '../src/store/operations';
import type { State } from '../src/types';

function success(r: Result) { assert.ok(r.ok, r.ok ? '' : r.reason); return r.state; }
function error(r: Result, code: WorkspaceError, field?: 'name' | 'color') {
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, code); if (field) assert.equal(r.field, field); }
}
function fixture(prepare?: (s: State) => void) {
  const state = { ...generateDemo(), authenticated: true };
  prepare?.(state);
  const platform = generatePlatformSeed();
  const data = new Map([[WORKSPACE_KEY, JSON.stringify(state)], [PLATFORM_KEY, JSON.stringify(platform)]]);
  const writes: string[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v); } };
  let admin = false;
  const options = { getPlatform: () => workspacePolicy(platform), hasAdminSession: () => admin, now: () => Date.parse('2026-10-24T12:00:00Z') };
  const store = createWorkspaceStore(storage, options);
  const rename = (name: string) => store.actions.updateOrganization({ name, expectedName: store.getState().organization.name });
  const company = (changes: { name?: string; color?: string }) => {
    const c = store.getState().companies[0];
    return store.actions.updateCompany({ companyId: c.id, changes, expected: { name: c.name, color: c.color } });
  };
  return { state, platform, data, writes, storage, options, store, rename, company, setAdmin: () => { admin = true; } };
}
function unchanged(f: ReturnType<typeof fixture>, run: () => Result, code: WorkspaceError, field?: 'name' | 'color') {
  const before = structuredClone(f.store.getState()), raw = f.data.get(WORKSPACE_KEY), platform = f.data.get(PLATFORM_KEY);
  const count = f.writes.filter(k => k === WORKSPACE_KEY).length;
  error(run(), code, field);
  assert.deepEqual(f.store.getState(), before);
  assert.equal(f.data.get(WORKSPACE_KEY), raw);
  assert.equal(f.data.get(PLATFORM_KEY), platform);
  assert.equal(f.writes.filter(k => k === WORKSPACE_KEY).length, count);
}

for (const mode of ['worker', 'client', 'admin', 'logout', 'organization', 'member'] as const) {
  test(`ajustes: rechazo sin mutación para ${mode}`, () => {
    const f = fixture();
    if (mode === 'worker' || mode === 'client') {
      success(f.store.actions.setRole(mode));
      assert.equal(can(mode, 'editOrganization'), false); assert.equal(can(mode, 'editCompany'), false);
    }
    if (mode === 'admin') f.setAdmin();
    if (mode === 'logout') success(f.store.actions.logout());
    if (mode === 'organization') f.platform.organizations[0].status = 'suspended';
    if (mode === 'member') f.platform.memberAccess.push({ organizationId: 'org-1', userId: f.state.activeUserId, status: 'suspended' });
    for (const run of [() => f.rename('Nuevo nombre'), () => f.company({ color: '#123456' }), () => f.store.actions.createCompany('Nueva', '#123456')])
      unchanged(f, run, 'forbidden');
  });
}
test('identidad y permiso se releen dentro del lease con sesión ya abierta', () => {
  const f = fixture();
  const raw = { ...f.state, revision: f.state.revision + 1, users: f.state.users.map(u => u.id === f.state.activeUserId ? { ...u, role: 'worker' } : u) };
  f.data.set(WORKSPACE_KEY, JSON.stringify(raw));
  const before = f.data.get(WORKSPACE_KEY);
  error(f.rename('No permitido'), 'forbidden');
  assert.equal(f.data.get(WORKSPACE_KEY), before);
  assert.equal(f.store.getState().users.find(u => u.id === f.state.activeUserId)!.role, 'worker');
});
test('puerta y sesión administrativa se vuelven a comprobar dentro de la sección crítica', () => {
  for (const mode of ['access', 'admin'] as const) {
    const f = fixture(), set = f.storage.setItem;
    f.storage.setItem = (k, v) => {
      set(k, v);
      if (k === WORKSPACE_KEY + ':lock') {
        if (mode === 'access') f.platform.organizations[0].status = 'suspended';
        else f.setAdmin();
      }
    };
    unchanged(f, () => f.rename('No permitido'), 'forbidden');
  }
});
test('conservación profunda, revisión exacta, nombres vivos e invitación anterior utilizable', () => {
  const f = fixture();
  success(f.store.actions.createInvitation({ email: 'persona@example.com', role: 'worker', companyIds: [f.state.companies[0].id] }));
  const before = structuredClone(f.store.getState()), code = before.invitations[0].code;
  const renamed = success(f.rename('  Táller   X  '));
  assert.deepEqual(renamed, { ...before, revision: before.revision + 1, organization: { ...before.organization, name: 'Táller X' } });
  const edited = success(f.company({ name: '  Empresa   Ágil ', color: '#ABCDEF' }));
  assert.deepEqual(edited, { ...renamed, revision: renamed.revision + 1, companies: renamed.companies.map((c, i) => i === 0 ? { ...c, name: 'Empresa Ágil', color: '#abcdef' } : c) });
  assert.deepEqual(f.store.actions.inspectInvitation(code), { status: 'valid', organization: 'Táller X', companies: ['Empresa Ágil'], role: 'worker' });
  assert.equal(f.writes.includes(PLATFORM_KEY), false);
  success(f.store.actions.logout());
  success(f.store.actions.acceptInvitation(code, { name: 'Persona Nueva', email: 'persona@example.com' }));
  assert.equal(f.store.actions.inspectInvitation(code).status, 'used');
});
test('sin cambios no escribe documentos ni incrementa revisión', () => {
  const f = fixture(), before = f.store.getState();
  success(f.rename('  ' + before.organization.name + '  '));
  success(f.company({}));
  success(f.company({ name: before.companies[0].name, color: before.companies[0].color.toUpperCase() }));
  assert.deepEqual(f.store.getState(), before);
  assert.equal(f.writes.filter(k => k === WORKSPACE_KEY).length, 0);
});
for (const length of [0, 1, 2, 80, 81]) {
  test(`longitud limpia ${length}: organización, creación y edición de empresa`, () => {
    const f = fixture(), name = '  ' + 'A'.repeat(length) + '  ';
    const runs = [() => f.rename(name), () => f.company({ name }), () => f.store.actions.createCompany(name + '', '#123456')];
    for (let i = 0; i < runs.length; i++) {
      if (length < 2 || length > 80) unchanged(f, runs[i], 'invalid_input', 'name');
      else {
        if (i === 2) { const g = fixture(); assert.equal(success(g.store.actions.createCompany(name, '#123456')).companies.at(-1)!.name.length, length); }
        else success(runs[i]());
      }
    }
  });
}
test('unicidad normalizada dentro de la organización y escritura conservada', () => {
  const f = fixture();
  const created = success(f.store.actions.createCompany('  Café   Central  ', '#ABCDEF')).companies.at(-1)!;
  assert.equal(created.name, 'Café Central'); assert.equal(created.color, '#abcdef');
  for (const name of ['cafe central', ' CAFÉ   CENTRAL ', 'Café Central']) {
    unchanged(f, () => f.store.actions.createCompany(name, '#000000'), 'duplicate_name', 'name');
    unchanged(f, () => f.company({ name }), 'duplicate_name', 'name');
  }
  success(f.company({ name: f.state.companies[0].name.toLowerCase() }));
  const g = fixture(s => { s.companies.push({ id: 'ajena', organizationId: 'otra', name: 'Solo Otra', color: '#ffffff' }); });
  success(g.store.actions.createCompany('Solo Otra', '#ffffff'));
  unchanged(g, () => g.store.actions.updateCompany({ companyId: 'ajena', changes: { color: '#000000' }, expected: { color: '#ffffff' } }), 'not_found');
  unchanged(g, () => g.store.actions.updateCompany({ companyId: 'ausente', changes: {}, expected: {} }), 'not_found');
});
test('duplicados previos y nombres cortos no bloquean color ni fuerzan reparaciones', () => {
  const f = fixture(s => { s.companies[0].name = 'X'; s.companies[1].name = 'X'; });
  const before = f.store.getState();
  const after = success(f.company({ name: ' X ', color: '#000000' }));
  assert.deepEqual(after.companies, before.companies.map((c, i) => i ? c : { ...c, color: '#000000' }));
  unchanged(f, () => f.company({ name: before.companies[2].name }), 'duplicate_name', 'name');
  const g = fixture(s => { s.companies[0].name = 'ecoplanes'; s.companies[1].name = 'Distinta'; });
  assert.equal(success(g.company({ name: 'Ecoplanes' })).companies[0].name, 'Ecoplanes');
});
for (const color of ['#fff', '#12345', 'red', '#GGGGGG', ' #123456', '#123456 ', null, 123]) {
  test(`color inválido rechazado sin mutar: ${color}`, () => {
    const f = fixture();
    unchanged(f, () => f.company({ color: color as string }), 'invalid_color', 'color');
    unchanged(f, () => f.store.actions.createCompany('Nueva', color as string), 'invalid_color', 'color');
  });
}
test('todos los colores válidos se admiten independientemente del contraste', () => {
  const f = fixture();
  for (const color of ['#000000', '#FFFFFF', '#FFFF00', '#000080', '#777777', '#888888']) {
    assert.equal(success(f.company({ color })).companies[0].color, color.toLowerCase());
    assert.equal(success(f.store.actions.createCompany('Color ' + color, color)).companies.at(-1)!.color, color.toLowerCase());
  }
});
test('dos instancias: conflictos por nombre de organización y campos de empresa', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options);
  const original = f.store.getState(), c = original.companies[0];
  success(b.actions.updateOrganization({ name: 'Nombre B', expectedName: original.organization.name }));
  error(f.rename('Nombre A'), 'conflict', 'name');
  assert.equal(JSON.parse(f.data.get(WORKSPACE_KEY)!).organization.name, 'Nombre B');
  success(b.actions.updateCompany({ companyId: c.id, changes: { name: 'Empresa B' }, expected: { name: c.name } }));
  success(f.store.actions.updateCompany({ companyId: c.id, changes: { color: '#000000' }, expected: { color: c.color } }));
  const merged = f.store.getState().companies[0];
  assert.equal(merged.name, 'Empresa B'); assert.equal(merged.color, '#000000');
  const raw = f.data.get(WORKSPACE_KEY);
  error(f.store.actions.updateCompany({ companyId: c.id, changes: { name: 'Empresa A' }, expected: { name: c.name } }), 'conflict', 'name');
  error(b.actions.updateCompany({ companyId: c.id, changes: { color: '#ffffff' }, expected: { color: c.color } }), 'conflict', 'color');
  assert.equal(f.data.get(WORKSPACE_KEY), raw);
});
test('cambios ajenos de contenido, accesos y otras empresas no bloquean ajustes', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options), before = f.store.getState();
  const post = before.posts[0];
  success(b.actions.createPost({ ...post, title: 'Publicación concurrente' }));
  success(b.actions.addComment(post.id, 'Comentario concurrente'));
  success(b.actions.assignCompanyAccess('ana', before.companies[2].id));
  const other = before.companies[1];
  success(b.actions.updateCompany({ companyId: other.id, changes: { name: 'Otra empresa' }, expected: { name: other.name } }));
  const fresh = b.getState();
  const result = success(f.rename('Ajustes después'));
  assert.deepEqual(result, { ...fresh, organization: { ...fresh.organization, name: 'Ajustes después' }, revision: fresh.revision + 1 });
});
test('lease ocupado devuelve conflicto sin pérdida ni escrituras', () => {
  const f = fixture();
  f.data.set(WORKSPACE_KEY + ':lock', JSON.stringify({ token: 'otra', expiresAt: f.options.now() + 2000 }));
  const data = new Map(f.data);
  unchanged(f, () => f.rename('Nuevo'), 'conflict');
  unchanged(f, () => f.company({ name: 'Nueva' }), 'conflict');
  assert.deepEqual(f.data, data); assert.deepEqual(f.writes, []);
});
test('plataforma: nombres visibles, sin sincronizar copias, nombre anterior liberado', () => {
  const f = fixture(), oldName = f.state.organization.name;
  const p = createPlatformStore(f.storage, { getSession: () => ({ kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID }) });
  unchanged(f, () => f.rename('  ' + f.platform.organizations[1].name.toUpperCase() + '  '), 'duplicate_name', 'name');
  success(f.rename('Taller X'));
  const directory = workspaceDirectory(f.store.getState()), raw = f.data.get(PLATFORM_KEY);
  const list = p.listOrganizations(directory), view = p.viewOrganization('org-1', directory);
  assert.ok(list.ok && view.ok);
  assert.equal(list.value.find(o => o.id === 'org-1')!.name, 'Taller X');
  assert.equal(view.value.organization.name, 'Taller X');
  assert.equal(f.writes.includes(PLATFORM_KEY), false);
  assert.equal(p.getState().organizations[0].name, oldName);
  const input = { name: ' táller   x ', managerName: 'Otra Persona', email: 'nueva@example.com' };
  assert.ok(validateOrganizationField(p.getState(), 'name', input.name, directory));
  assert.equal(validateOrganization(p.getState(), input, directory).ok, false);
  const duplicate = p.createOrganization(input, directory);
  assert.ok(!duplicate.ok && duplicate.code === 'duplicate_name');
  assert.equal(f.data.get(PLATFORM_KEY), raw);
  assert.equal(p.createOrganization({ ...input, name: oldName }, directory).ok, true);
  assert.equal(workspacePolicy(f.platform, directory).organizationNameTaken('TÁLLER X', 'otra'), true);
  assert.equal(workspacePolicy(f.platform, directory).organizationNameTaken('Taller X', 'org-1'), false);
  // Sin directorio se conserva el contrato previo de validación.
  assert.equal(validateOrganization(f.platform, { ...input, name: oldName }).ok, false);
});
