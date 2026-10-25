import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy, accessCausesForWorkspace } from '../src/platform/access';
import { workspaceDirectory } from '../src/platform/directory';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { can } from '../src/store/permissions';
import { selectUser, selectResponsibleUsers, selectAssignableUsers, selectDemoGroups, responsibleLabel } from '../src/store/selectors';
import { resolveRoute } from '../src/auth/routeGuard';
import { resolveWorkspaceGate } from '../src/features/access/workspaceGate';
import { buildSubmission, changedFields, draftIsCurrent, editDraft, EMAIL_NOTICE, fieldErrors, isDirty, needsDiscardConfirmation, profileCard, profileDraft, recoverDraft, recoveryMessages, submissionHasChanges, submitState } from '../src/features/profile/profilePresentation';
import type { Result } from '../src/store/operations';

const state = () => ({ ...generateDemo(), authenticated: true });
const failure = (code: Extract<Result, { ok: false }>['code'], field?: 'name' | 'email' | 'color'): Extract<Result, { ok: false }> =>
  ({ ok: false, code, field, reason: 'Error del almacén' });
const source = (path: string) => readFileSync(path, 'utf8');

for (const length of [0, 1, 2, 80, 81]) test(`perfil UI: nombre limpio de longitud ${length}`, () => {
  const s = state(), d = editDraft(profileDraft(s), 'name', '  ' + 'Á'.repeat(length) + '  ');
  assert.equal(!!fieldErrors(s, d).name, length < 2 || length > 80);
});
for (const [email, invalid] of [
  ['', false], ['   ', false], [' NUEVO@EXAMPLE.COM ', false], ['no-es-correo', true],
  ['a b@example.com', true], ['x'.repeat(108) + '@example.com', false], ['x'.repeat(109) + '@example.com', true],
] as const) test(`perfil UI: correo opcional y límite ${email.length}`, () => {
  const s = state(), d = editDraft(profileDraft(s), 'email', email);
  assert.equal(!!fieldErrors(s, d).email, invalid);
});
test('validación informativa excluye a la propia persona y permite nombre heredado sin cambios', () => {
  const s = state(), user = selectUser(s);
  user.name = 'X'; user.email = 'propio@example.com';
  let d = editDraft(profileDraft(s), 'email', ' PROPIO@EXAMPLE.COM ');
  assert.deepEqual(fieldErrors(s, d), {});
  d = editDraft(d, 'email', 'nuevo@example.com');
  assert.equal(fieldErrors(s, d).name, undefined);
  s.users.find(u => u.id !== user.id)!.email = ' NUEVO@EXAMPLE.COM ';
  assert.ok(fieldErrors(s, d).email);
});
test('dirty, descarte, normalización y cambios/expected solo de campos modificados', () => {
  const s = state(), user = selectUser(s);
  delete user.email;
  const base = profileDraft(s);
  assert.equal(isDirty(base), false);
  assert.equal(submitState(s, base).disabled, true);
  assert.equal(needsDiscardConfirmation(editDraft(base, 'name', ' ' + user.name + ' ')), false);
  const name = editDraft(base, 'name', ' Nombre   Nuevo ');
  assert.equal(submitState(s, name).disabled, false);
  assert.equal(needsDiscardConfirmation(name), true);
  assert.deepEqual(buildSubmission(name), { changes: { name: 'Nombre Nuevo' }, expected: { name: user.name } });
  const email = editDraft(base, 'email', ' NUEVO@EXAMPLE.COM ');
  assert.deepEqual(buildSubmission(email), { changes: { email: 'nuevo@example.com' }, expected: { email: undefined } });
  assert.ok(Object.hasOwn(buildSubmission(email).expected, 'email'));
  assert.deepEqual(buildSubmission(editDraft(name, 'email', 'nuevo@example.com')).changes, { name: 'Nombre Nuevo', email: 'nuevo@example.com' });
  user.email = 'viejo@example.com';
  assert.deepEqual(buildSubmission(editDraft(profileDraft(s), 'email', '  ')), { changes: { email: '' }, expected: { email: user.email } });
});
for (const code of ['conflict', 'storage_unavailable', 'duplicate_email', 'invalid_input', 'forbidden', 'not_found'] as const) test(`recuperación de ${code}: etiqueta, bloqueo y conservación`, () => {
  const s = state(), d = editDraft(editDraft(profileDraft(s), 'name', 'Mi borrador'), 'email', 'mio@example.com');
  const fresh = structuredClone(s), person = selectUser(fresh);
  person.name = 'Nombre concurrente'; person.email = 'actual@example.com';
  const recovered = recoverDraft(d, failure(code, 'email'), fresh, true);
  assert.deepEqual(recovered.base, d.base);
  assert.deepEqual(recovered.values, d.values);
  const transient = code === 'conflict' || code === 'storage_unavailable';
  assert.equal(submitState(fresh, recovered).label, transient ? 'Reintentar' : 'Guardar');
  assert.equal(submitState(fresh, recovered).disabled, code === 'forbidden' || code === 'not_found');
  assert.equal(fieldErrors(fresh, recovered).email, transient ? undefined : 'Error del almacén');
  assert.deepEqual(buildSubmission(recovered).expected, transient ? { name: person.name, email: person.email } : d.base);
  if (transient) {
    assert.match(recoveryMessages(recovered).join(' '), /Nombre concurrente.*actual@example.com/);
    const unavailable = recoverDraft(d, failure(code), fresh, false);
    assert.equal(submitState(fresh, unavailable).disabled, true);
    assert.deepEqual(buildSubmission(unavailable).expected, d.base);
    assert.match(recoveryMessages(unavailable).join(''), /No se pudieron actualizar/);
  }
});
test('mapea errores name/email y limpia solo el error del campo editado', () => {
  const s = state(), d = editDraft(profileDraft(s), 'name', 'Nuevo');
  for (const field of ['name', 'email'] as const) {
    const recovered = recoverDraft(d, failure('invalid_input', field), s, true);
    assert.equal(fieldErrors(s, recovered)[field], 'Error del almacén');
    assert.equal(editDraft(recovered, field, field === 'name' ? 'Otro' : '').failure, undefined);
  }
  assert.deepEqual(fieldErrors(s, recoverDraft(d, failure('invalid_input', 'color'), s, true)), {});
});
test('desaparición bloquea; identidad distinta invalida incluso con valores idénticos', () => {
  const s = state(), d = editDraft(profileDraft(s), 'name', 'Borrador anterior');
  const other = s.users.find(u => u.id !== d.personId)!;
  other.name = d.base.name; other.email = d.base.email;
  s.activeUserId = other.id;
  assert.equal(draftIsCurrent(s, d), false);
  assert.equal(submitState(s, d).disabled, true);
  assert.equal(recoverDraft(d, failure('conflict'), s, true).ready, false);
  s.activeUserId = d.personId;
  s.users = s.users.filter(u => u.id !== d.personId);
  assert.equal(recoverDraft(d, failure('conflict'), s, true).failure?.code, 'not_found');
  assert.equal(submitState(s, d).disabled, true);
});
test('reintento sin cambio real no produce éxito engañoso y muestra correo ausente', () => {
  const s = state(), user = selectUser(s);
  user.email = 'antes@example.com';
  const d = editDraft(editDraft(profileDraft(s), 'name', 'Concurrente'), 'email', '');
  const fresh = structuredClone(s);
  selectUser(fresh).name = 'Concurrente'; delete selectUser(fresh).email;
  const recovered = recoverDraft(d, failure('conflict'), fresh, true);
  assert.equal(submissionHasChanges(recovered), false);
  assert.deepEqual(changedFields(recovered), { name: true, email: true });
  assert.match(recoveryMessages(recovered).join(''), /sin correo/);
});
test('tarjeta: roles, empresas de organización, ausencia de correo y datos de ejemplo', () => {
  const s = state();
  for (const [role, label] of [['community_manager', 'Community manager'], ['worker', 'Trabajador'], ['client', 'Cliente']] as const) {
    const user = s.users.find(u => u.role === role)!;
    delete user.email; user.example = true;
    const card = profileCard(s, user);
    assert.equal(card.role, label); assert.equal(card.email, 'Sin correo registrado'); assert.equal(card.example, 'Datos de ejemplo');
    assert.deepEqual(card.companies, role === 'community_manager' ? ['Todas las empresas'] :
      s.companies.filter(c => c.organizationId === s.organization.id && s.memberships.some(m => m.companyId === c.id && m.userId === user.id)).map(c => c.name));
    s.memberships = s.memberships.filter(m => m.userId !== user.id);
    user.example = false;
    assert.deepEqual(profileCard(s, user).companies, [role === 'community_manager' ? 'Todas las empresas' : 'Sin empresas asignadas']);
    assert.equal(profileCard(s, user).example, undefined);
  }
  const worker = s.users.find(u => u.role === 'worker')!;
  s.companies.push({ id: 'ajena', organizationId: 'ajena', name: 'No mostrar', color: '#000000' });
  s.memberships.push({ id: 'ajena', userId: worker.id, companyId: 'ajena' });
  assert.deepEqual(profileCard(s, worker).companies, ['Sin empresas asignadas']);
});
test('ruta viva, permisos, exclusión administrativa y bloqueo de suspensión previo al Workspace', () => {
  for (const role of ['community_manager', 'worker', 'client'] as const) assert.equal(can(role, 'editOwnProfile'), true);
  assert.equal(resolveRoute('platform_admin', '/perfil').view, 'platform');
  assert.equal(resolveRoute('workspace', '/perfil').view, 'workspace');
  const workspace = source('src/features/workspace/Workspace.tsx'), app = source('src/App.tsx');
  assert.match(workspace, /path="\/perfil" element=\{can\(s.role, 'editOwnProfile'\).*<Navigate to=\{home\} replace/);
  assert.match(workspace, /<Profile key=\{s.activeUserId\}/);
  assert.ok(app.indexOf('if (blocked) return <AccessSuspended') < app.indexOf("<Workspace key={state.activeUserId}"));
  assert.ok(app.indexOf("if (view === 'platform') return <PlatformShell") < app.indexOf('<Workspace key='));
  for (const mode of ['member', 'organization']) {
    const s = state(), platform = generatePlatformSeed();
    if (mode === 'member') platform.memberAccess.find(a => a.userId === s.activeUserId)!.status = 'suspended';
    else platform.organizations.find(o => o.id === s.organization.id)!.status = 'suspended';
    assert.equal(resolveWorkspaceGate('workspace', accessCausesForWorkspace(platform, s.organization.id, s.activeUserId)).access, 'blocked');
  }
});
test('enlace accesible independiente de Salir y diálogo adaptable con guardas de identidad y foco', () => {
  const menu = source('src/features/workspace/ProfileMenu.tsx'), page = source('src/features/profile/Profile.tsx');
  assert.match(menu, /to="\/perfil".*aria-label=\{\x60Mi perfil, \$\{user.name\}\x60\}.*aria-current=.*onClick=\{onNavigate\}/);
  const start = menu.indexOf('<Link'), end = menu.indexOf('</Link>', start);
  assert.equal(menu.slice(start, end).includes('<button'), false);
  assert.ok(menu.indexOf('aria-label="Salir de la demostración"') > end);
  assert.match(page, /<Modal adaptive.*title="Editar perfil" initialFocus="#profile-name"/);
  assert.match(page, /if \(!draftIsCurrent\(live, draft\)\) \{ onClose\(\); return; \}/);
  assert.match(page, /role="status"><p>Perfil actualizado\./);
  assert.match(page, /title="Descartar cambios sin guardar"/);
  assert.match(page, /if \(!submissionHasChanges\(draft\)\) \{ onClose\(\); return; \}/);
  assert.equal(EMAIL_NOTICE, 'El correo no se verifica en esta demostración: no se envía ningún mensaje de confirmación.');
  assert.match(page, /\{EMAIL_NOTICE\}/);
  assert.match(source('src/styles.css'), /\.profile-link strong, \.demo-mode label \{ overflow-wrap: anywhere;/);
  assert.match(source('src/components/ui.tsx'), /if \(previous\?\.isConnected\) previous.focus\(\)/);
});
function fixture() {
  const initial = state();
  initial.posts[0].responsibleId = initial.activeUserId;
  const data = new Map([[WORKSPACE_KEY, JSON.stringify(initial)]]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const platform = generatePlatformSeed(), options = { getPlatform: () => workspacePolicy(platform) };
  return { store: createWorkspaceStore(storage, options), other: createWorkspaceStore(storage, options), data, platform };
}
test('UI + almacén compartido: conserva ids y todas las relaciones; nombres vivos y directorio sin correo', () => {
  const { store, other, platform, data } = fixture();
  assert.ok(store.actions.createInvitation({ email: 'invitado@example.com', role: 'worker', companyIds: [store.getState().companies[0].id] }).ok);
  const before = structuredClone(store.getState()), originalPlatform = structuredClone(platform);
  const d = editDraft(editDraft(profileDraft(before), 'name', 'Nombre Vivo'), 'email', ' VIVO@EXAMPLE.COM ');
  assert.ok(store.actions.updateProfile(buildSubmission(d)).ok);
  assert.equal(other.actions.refresh(), true);
  const after = other.getState(), user = selectUser(after), companyId = after.posts[0].companyId;
  assert.deepEqual(after, { ...before, revision: before.revision + 1,
    users: before.users.map(u => u.id === d.personId ? { ...u, name: 'Nombre Vivo', email: 'vivo@example.com' } : u) });
  assert.equal(user.name, 'Nombre Vivo');
  for (const users of [selectResponsibleUsers(after, companyId), selectAssignableUsers(after, companyId)])
    assert.equal(users.find(u => u.id === user.id)!.name, user.name);
  assert.equal(responsibleLabel(after, companyId, user.id), user.name);
  assert.ok(selectDemoGroups(after, () => false).flatMap(g => g.people).find(p => p.id === user.id)!.label.startsWith(user.name));
  assert.deepEqual(workspaceDirectory(after).users.find(u => u.id === user.id), { id: user.id, name: user.name, role: user.role, example: user.example });
  assert.deepEqual(platform, originalPlatform);
  assert.equal([...data.keys()].some(key => key.startsWith('agenda-platform')), false);
});
test('dos instancias: conflicto conserva borrador, refresh no escribe y reintento explícito gana', () => {
  const { store, other, data } = fixture(), before = store.getState();
  const d = editDraft(profileDraft(before), 'email', 'borrador@example.com');
  assert.ok(other.actions.updateProfile(buildSubmission(editDraft(profileDraft(other.getState()), 'email', 'concurrente@example.com'))).ok);
  const result = store.actions.updateProfile(buildSubmission(d));
  assert.ok(!result.ok); assert.equal(result.code, 'conflict');
  const persisted = data.get(WORKSPACE_KEY);
  const ready = store.actions.refresh(), recovered = recoverDraft(d, result, store.getState(), ready);
  assert.deepEqual(recovered.values, d.values); assert.deepEqual(recovered.base, d.base);
  assert.equal(data.get(WORKSPACE_KEY), persisted);
  assert.equal(buildSubmission(recovered).expected.email, 'concurrente@example.com');
  assert.ok(store.actions.updateProfile(buildSubmission(recovered)).ok);
  assert.equal(selectUser(store.getState()).email, 'borrador@example.com');
});
test('aceptación resuelve nombre vivo por id y no lo conserva en el estado de éxito', () => {
  const page = source('src/features/invitation/InvitationPage.tsx');
  assert.match(page, /state.users.find\(u => u.id === success\?\.id\)\?\.name/);
  assert.doesNotMatch(page, /success.name|setSuccess\(\{ id, name:/);
});
