import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy } from '../src/platform/access';
import { workspaceDirectory, resolveDirectory } from '../src/platform/directory';
import { PLATFORM_KEY } from '../src/platform/store';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { can } from '../src/store/permissions';
import { selectUser, selectResponsibleUsers, selectAssignableUsers, selectDemoGroups } from '../src/store/selectors';
import type { ProfileUpdate } from '../src/store/profile';
import type { Result, WorkspaceError } from '../src/store/operations';
import type { State } from '../src/types';

function success(r: Result) { assert.ok(r.ok, r.ok ? '' : r.reason); return r.state; }
function error(r: Result, code: WorkspaceError, field?: 'name' | 'email') {
  assert.ok(!r.ok);
  assert.equal(r.code, code);
  if (field) assert.equal(r.field, field);
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
  const update = (changes: ProfileUpdate['changes']) => store.actions.updateProfile({ changes, expected: { ...selectUser(store.getState()) } });
  return { state, platform, data, writes, storage, options, store, update, setAdmin: () => { admin = true; } };
}
function unchanged(f: ReturnType<typeof fixture>, run: () => Result, code?: WorkspaceError, field?: 'name' | 'email') {
  const before = structuredClone(f.store.getState()), data = new Map(f.data);
  const count = f.writes.filter(k => k === WORKSPACE_KEY).length;
  if (code) error(run(), code, field); else success(run());
  assert.deepEqual(f.store.getState(), before);
  // El lease se adquiere y libera incluso ante validación o ausencia de cambios.
  assert.deepEqual(new Map([...f.data].filter(([k]) => !k.endsWith(':lock'))), new Map([...data].filter(([k]) => !k.endsWith(':lock'))));
  assert.equal(f.writes.filter(k => k === WORKSPACE_KEY).length, count);
  assert.equal(f.writes.includes(PLATFORM_KEY), false);
}
for (const role of ['community_manager', 'worker', 'client'] as const) {
  test(`perfil propio: ${role}, identidad activa y conservación profunda`, () => {
    const f = fixture();
    success(f.store.actions.createInvitation({ email: 'pendiente@example.com', role: 'worker', companyIds: [f.state.companies[0].id] }));
    const person = f.state.users.find(u => u.role === role)!;
    success(f.store.actions.setActiveUser(person.id));
    assert.equal(can(role, 'editOwnProfile'), true);
    const before = structuredClone(f.store.getState()), platform = structuredClone(f.platform);
    const after = success(f.update({ name: '  María   Ágil  ', email: ' MARIA@EXAMPLE.COM ' }));
    assert.deepEqual(after, { ...before, revision: before.revision + 1, users: before.users.map(u => u.id === person.id ? { ...u, name: 'María Ágil', email: 'maria@example.com' } : u) });
    assert.deepEqual(f.platform, platform);
    assert.equal(f.writes.includes(PLATFORM_KEY), false);
  });
}
for (const mode of ['admin', 'logout', 'member', 'organization'] as const) {
  test(`perfil: ${mode} denegado sin mutación`, () => {
    const f = fixture();
    if (mode === 'admin') f.setAdmin();
    if (mode === 'logout') success(f.store.actions.logout());
    if (mode === 'member') f.platform.memberAccess.find(a => a.userId === f.state.activeUserId)!.status = 'suspended';
    if (mode === 'organization') f.platform.organizations[0].status = 'suspended';
    const platform = structuredClone(f.platform);
    unchanged(f, () => f.update({ name: 'Otro Nombre', email: 'otro@example.com' }), 'forbidden');
    assert.deepEqual(f.platform, platform);
  });
}
test('guardas se releen dentro del lease', () => {
  for (const mode of ['admin', 'member', 'organization'] as const) {
    const f = fixture(), set = f.storage.setItem;
    f.storage.setItem = (k, v) => {
      set(k, v);
      if (k.endsWith(':lock')) {
        if (mode === 'admin') f.setAdmin();
        if (mode === 'member') f.platform.memberAccess.find(a => a.userId === f.state.activeUserId)!.status = 'suspended';
        if (mode === 'organization') f.platform.organizations[0].status = 'suspended';
      }
    };
    unchanged(f, () => f.update({ name: 'Nuevo' }), 'forbidden');
  }
});
test('persona eliminada devuelve not_found y no escribe', () => {
  const f = fixture();
  const fresh = { ...f.state, revision: f.state.revision + 1, users: f.state.users.filter(u => u.id !== f.state.activeUserId) };
  f.data.set(WORKSPACE_KEY, JSON.stringify(fresh));
  const raw = f.data.get(WORKSPACE_KEY);
  error(f.update({ name: 'Nuevo' }), 'not_found');
  assert.equal(f.data.get(WORKSPACE_KEY), raw);
});
for (const length of [0, 1, 2, 80, 81]) {
  test(`nombre limpio: longitud ${length}`, () => {
    const f = fixture(), name = '  ' + 'Á'.repeat(length) + '  ';
    if (length < 2 || length > 80) unchanged(f, () => f.update({ name }), 'invalid_input', 'name');
    else assert.equal(selectUser(success(f.update({ name }))).name, name.trim());
  });
}
test('datos previos y campos ausentes: no exige corregir ni escribe sin cambios', () => {
  const f = fixture(s => { s.users[0].name = 'X'; delete s.users[0].email; s.users[1].email = ''; });
  unchanged(f, () => f.update({ name: ' X ' }));
  unchanged(f, () => f.update({ email: '  ' }));
  unchanged(f, () => f.update({}));
  const before = f.store.getState();
  const after = success(f.update({ name: 'Nombre válido' }));
  assert.deepEqual(after.users, before.users.map(u => u.id === before.activeUserId ? { ...u, name: 'Nombre válido' } : u));
  assert.equal(Object.hasOwn(selectUser(after), 'email'), false);
});
for (const email of ['sin-arroba', 'a@b', 'a b@example.com', 'a'.repeat(109) + '@example.com']) {
  test(`correo inválido: ${email}`, () => {
    const f = fixture();
    unchanged(f, () => f.update({ email }), 'invalid_input', 'email');
  });
}
test('correo: límite 120, normalización, propio, eliminación y unicidad normalizada', () => {
  const f = fixture(s => { s.users[1].email = ' OTRA@EXAMPLE.COM '; });
  const email = 'a'.repeat(108) + '@example.com';
  assert.equal(email.length, 120);
  assert.equal(selectUser(success(f.update({ email }))).email, email);
  unchanged(f, () => f.update({ email: ' ' + email.toUpperCase() + ' ' }));
  unchanged(f, () => f.update({ email: 'otra@example.com' }), 'duplicate_email', 'email');
  assert.equal(Object.hasOwn(selectUser(success(f.update({ email: '  ' }))), 'email'), false);
  unchanged(f, () => f.update({ email: '' }));
  const g = fixture(s => { s.users[0].email = ''; });
  assert.equal(Object.hasOwn(selectUser(success(g.update({ email: '' }))), 'email'), false);
});
test('plataforma e invitaciones pendientes no reservan correo; aceptación posterior existing_member', () => {
  const f = fixture();
  success(f.update({ email: f.platform.members[0].email }));
  success(f.store.actions.createInvitation({ email: 'invitado@example.com', role: 'worker', companyIds: [f.state.companies[0].id] }));
  const invitation = f.store.getState().invitations[0];
  success(f.update({ email: invitation.email }));
  assert.deepEqual(f.store.getState().invitations[0], invitation);
  success(f.store.actions.logout());
  unchanged(f, () => f.store.actions.acceptInvitation(invitation.code, { name: 'Persona Nueva', email: invitation.email }), 'existing_member');
});
test('dos instancias: conflicto solo por campos editados, correo ausente y nombre concurrente', () => {
  const f = fixture(s => { delete s.users[0].email; }), b = createWorkspaceStore(f.storage, f.options);
  const original = selectUser(f.store.getState());
  success(b.actions.updateProfile({ changes: { name: 'Nombre B' }, expected: { name: original.name } }));
  const raw = f.data.get(WORKSPACE_KEY);
  error(f.update({ name: 'Nombre A' }), 'conflict', 'name');
  assert.equal(f.data.get(WORKSPACE_KEY), raw);
  const result = success(f.store.actions.updateProfile({ changes: { email: 'nuevo@example.com' }, expected: { email: undefined } }));
  assert.equal(selectUser(result).name, 'Nombre B');
  assert.equal(selectUser(result).email, 'nuevo@example.com');
  error(b.actions.updateProfile({ changes: { email: 'otro@example.com' }, expected: {} }), 'conflict', 'email');
  assert.equal(f.data.get(WORKSPACE_KEY), JSON.stringify(result));
});
test('cambios ajenos de contenido, accesos, invitaciones y empresas no bloquean', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options), before = f.store.getState();
  success(b.actions.createPost({ ...before.posts[0], title: 'Publicación concurrente' }));
  success(b.actions.addComment(before.posts[0].id, 'Comentario concurrente'));
  success(b.actions.assignCompanyAccess('ana', before.companies[2].id));
  success(b.actions.createInvitation({ email: 'pendiente@example.com', role: 'client', companyIds: [before.companies[0].id] }));
  success(b.actions.updateCompany({ companyId: before.companies[0].id, changes: { name: 'Otra empresa' }, expected: { name: before.companies[0].name } }));
  const fresh = b.getState(), result = success(f.update({ name: 'Nuevo Nombre' }));
  assert.deepEqual(result, { ...fresh, revision: fresh.revision + 1, users: fresh.users.map(u => u.id === before.activeUserId ? { ...u, name: 'Nuevo Nombre' } : u) });
});
test('dos personas compiten por correo: la segunda recibe duplicate_email', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options);
  success(b.actions.setActiveUser('ana'));
  const old = selectUser(b.getState());
  success(f.update({ email: 'unico@example.com' }));
  const raw = f.data.get(WORKSPACE_KEY);
  error(b.actions.updateProfile({ changes: { email: 'UNICO@example.com' }, expected: { email: old.email } }), 'duplicate_email', 'email');
  assert.equal(f.data.get(WORKSPACE_KEY), raw);
  assert.deepEqual(selectUser(b.getState()), old);
});
test('lease ocupado: conflicto sin pérdida', () => {
  const f = fixture();
  f.data.set(WORKSPACE_KEY + ':lock', JSON.stringify({ token: 'otra', expiresAt: f.options.now() + 2000 }));
  const data = new Map(f.data);
  unchanged(f, () => f.update({ name: 'Nuevo' }), 'conflict');
  assert.deepEqual(f.data, data);
  assert.deepEqual(f.writes, []);
});
test('nombre vivo en selectores, responsables, opciones y directorio sin correo ni escrituras de plataforma', () => {
  const f = fixture(s => { s.posts[0].responsibleId = s.activeUserId; });
  const b = createWorkspaceStore(f.storage, f.options), platform = structuredClone(f.platform);
  const after = success(f.update({ name: 'Ángela Nueva', email: 'angela@example.com' }));
  b.refresh();
  const reloaded = createWorkspaceStore(f.storage, f.options);
  for (const state of [after, b.getState(), reloaded.getState()]) {
    const user = selectUser(state), company = state.posts[0].companyId;
    assert.equal(user.name, 'Ángela Nueva');
    for (const people of [selectResponsibleUsers(state, company), selectAssignableUsers(state, company)])
      assert.equal(people.find(u => u.id === user.id)!.name, user.name);
    const directory = workspaceDirectory(state);
    assert.deepEqual(directory.users.find(u => u.id === user.id), { id: user.id, name: user.name, role: user.role, example: user.example });
    assert.deepEqual(resolveDirectory(f.platform, directory, state.organization.id).members.find(u => u.userId === user.id), { userId: user.id, name: user.name, role: user.role, example: user.example });
    assert.ok(selectDemoGroups(state, f.store.actions.memberSuspended).flatMap(g => g.people).find(u => u.id === user.id)!.label.startsWith(user.name));
  }
  assert.deepEqual(f.platform, platform);
  assert.equal(f.writes.includes(PLATFORM_KEY), false);
});

test('cambiar de persona invalida el borrador anterior y un userId extra no selecciona perfiles ajenos', () => {
  const f = fixture(), original = selectUser(f.store.getState());
  const draft = { changes: { name: 'Nombre del borrador' }, expected: { name: original.name } };
  success(f.store.actions.setActiveUser('ana'));
  unchanged(f, () => f.store.actions.updateProfile(draft), 'conflict', 'name');
  const before = f.store.getState(), active = selectUser(before);
  const input = { userId: original.id, changes: { name: 'Persona activa' }, expected: { name: active.name } };
  const after = success(f.store.actions.updateProfile(input));
  assert.deepEqual(after, { ...before, revision: before.revision + 1, users: before.users.map(u => u.id === active.id ? { ...u, name: 'Persona activa' } : u) });
  assert.deepEqual(after.users.find(u => u.id === original.id), original);
});
test('solo propiedades propias; validación y conflicto de correo no guardan un nombre parcial', () => {
  const f = fixture();
  const changes = Object.create({ name: 'Nombre heredado', email: 'heredado@example.com' }) as ProfileUpdate['changes'];
  unchanged(f, () => f.store.actions.updateProfile({ changes, expected: {} }));
  unchanged(f, () => f.update({ name: 'Nombre válido', email: 'inválido' }), 'invalid_input', 'email');
  unchanged(f, () => f.store.actions.updateProfile({ changes: { name: 'Nombre válido', email: 'nuevo@example.com' }, expected: { name: selectUser(f.store.getState()).name, email: 'viejo@example.com' } }), 'conflict', 'email');
});
test('correo esperado ausente equivale a undefined, pero nunca a cadena vacía', () => {
  const f = fixture(s => { delete s.users[0].email; });
  unchanged(f, () => f.store.actions.updateProfile({ changes: { email: 'nuevo@example.com' }, expected: { email: '' } }), 'conflict', 'email');
  success(f.store.actions.updateProfile({ changes: { email: 'nuevo@example.com' }, expected: {} }));
  const g = fixture(s => { s.users[0].email = ''; delete s.users[1].email; });
  const before = g.store.getState();
  const after = success(g.update({ name: 'Solo Nombre' }));
  assert.deepEqual(after.users, before.users.map(u => u.id === before.activeUserId ? { ...u, name: 'Solo Nombre' } : u));
  unchanged(g, () => g.store.actions.updateProfile({ changes: { email: 'nuevo@example.com' }, expected: {} }), 'conflict', 'email');
});
test('perfil aceptado conserva usedBy, comentarios y suspensión ajena con sus metadatos', () => {
  const f = fixture();
  const suspended = f.platform.memberAccess.find(a => a.userId === 'ana')!;
  suspended.status = 'suspended';
  suspended.suspension = { at: '2026-10-24T12:00:00Z', reason: 'Suspensión conservada' };
  success(f.store.actions.createInvitation({ email: 'aceptado@example.com', role: 'worker', companyIds: [f.state.companies[0].id] }));
  const code = f.store.getState().invitations[0].code;
  success(f.store.actions.logout());
  success(f.store.actions.acceptInvitation(code, { name: 'Persona Aceptada', email: 'aceptado@example.com' }));
  const id = f.store.getState().invitations[0].usedBy!;
  success(f.store.actions.enterAs(id));
  success(f.store.actions.addComment(f.state.posts[0].id, 'Comentario de la persona aceptada'));
  const before = structuredClone(f.store.getState()), platform = structuredClone(f.platform);
  const after = success(f.update({ name: 'Nombre Actualizado', email: 'actualizado@example.com' }));
  assert.deepEqual(after, { ...before, revision: before.revision + 1, users: before.users.map(u => u.id === id ? { ...u, name: 'Nombre Actualizado', email: 'actualizado@example.com' } : u) });
  assert.equal(after.users.find(u => u.id === after.invitations[0].usedBy)!.name, 'Nombre Actualizado');
  assert.equal(after.users.find(u => u.id === after.comments.at(-1)!.authorId)!.name, 'Nombre Actualizado');
  assert.equal(workspacePolicy(f.platform).accessAllowed(after.organization.id, 'ana'), false);
  assert.deepEqual(f.platform, platform);
  assert.equal(f.writes.includes(PLATFORM_KEY), false);
  success(f.store.actions.setActiveUser('ana'));
  unchanged(f, () => f.update({ name: 'Suspendida' }), 'forbidden');
});
test('otra persona cambia sin bloquear el perfil local ni sustituir su sesión', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options), original = selectUser(f.store.getState());
  success(b.actions.setActiveUser('ana'));
  const active = selectUser(b.getState());
  success(b.actions.updateProfile({ changes: { name: 'Ana Actualizada' }, expected: { name: active.name } }));
  const after = success(f.update({ name: 'Perfil Local' }));
  assert.equal(after.activeUserId, original.id);
  assert.equal(selectUser(after).name, 'Perfil Local');
  assert.equal(after.users.find(u => u.id === active.id)!.name, 'Ana Actualizada');
});
