import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy } from '../src/platform/access';
import { workspaceDirectory, resolveDirectory, reconcileWithDirectory } from '../src/platform/directory';
import { createWorkspaceStore, WORKSPACE_KEY as key } from '../src/store/workspace';
import { restoreWorkspace } from '../src/store/migration';
import { invitationStatus, type InvitationInput } from '../src/store/invitations';
import { selectPostsWithUnauthorizedResponsible, isResponsibleAuthorized } from '../src/store/selectors';
import { can } from '../src/store/permissions';
import type { Result, WorkspaceError } from '../src/store/operations';
import type { State, Role } from '../src/types';
class Storage {
  data = new Map<string, string>(); writes: string[] = [];
  hook?: (key: string, value: string) => void;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); this.writes.push(key); this.hook?.(key, value); }
}
const input: InvitationInput = { email: ' Nueva@Example.cl ', role: 'worker', companyIds: ['company-0', 'company-1'] };
function success(result: Result) { assert.ok(result.ok, result.ok ? '' : result.reason); return result.state; }
function error(result: Result, code: WorkspaceError) { assert.ok(!result.ok); assert.equal(result.code, code); }
function fixture(initial: State = { ...generateDemo(), authenticated: true }) {
  const storage = new Storage(), platform = generatePlatformSeed();
  let now = Date.parse('2026-10-21T12:00:00Z'), admin = false;
  storage.data.set(key, JSON.stringify(initial));
  const options = { getPlatform: () => workspacePolicy(platform), hasAdminSession: () => admin, now: () => now };
  const store = createWorkspaceStore(storage, options);
  return { store, storage, platform, options, setNow: (value: number) => { now = value; }, setAdmin: (value: boolean) => { admin = value; } };
}
function ready() {
  const f = fixture();
  const invitation = success(f.store.actions.createInvitation(input)).invitations[0];
  success(f.store.actions.logout());
  return { ...f, invitation };
}
function unchanged(f: ReturnType<typeof fixture>, attempt: () => Result, code: WorkspaceError) {
  const before = f.storage.getItem(key), state = structuredClone(f.store.getState());
  error(attempt(), code);
  assert.equal(f.storage.getItem(key), before); assert.deepEqual(f.store.getState(), state);
}
test('v2 → v3 conserva todos los datos, sin escrituras e idempotente en dos migraciones y relectura', () => {
  const original = generateDemo();
  const old = { ...original, version: 2, role: 'worker', authenticated: true } as Record<string, unknown>;
  delete old.revision; delete old.activeUserId; delete old.invitations;
  const raw = JSON.stringify(old), migrated = restoreWorkspace(raw);
  assert.deepEqual(migrated, { ...old, version: 3, revision: 0, activeUserId: 'ana', invitations: [] });
  assert.deepEqual(restoreWorkspace(raw), migrated);
  assert.deepEqual(restoreWorkspace(JSON.stringify(migrated)), migrated);
  assert.equal(restoreWorkspace(raw, true).authenticated, false);
  const f = fixture(migrated); assert.deepEqual(f.storage.writes, []);
});
test('restauración sanea lista blanca y rechaza códigos duplicados, estados inválidos y corrupción', () => {
  const f = ready(), state = f.store.getState();
  const dirty = { ...state, invitations: [{ ...state.invitations[0], secret: 'extra' }] };
  assert.deepEqual(restoreWorkspace(JSON.stringify(dirty)), state);
  // generateDemo fija marcas de tiempo con Date.now(): se compara la forma, no los instantes.
  const isDemo = (s: State) => s.version === 3 && s.revision === 0 && s.invitations.length === 0 && s.posts.length === generateDemo().posts.length;
  for (const invitations of [[...state.invitations, ...state.invitations], [{ ...state.invitations[0], usedAt: 'mal' }], [{ ...state.invitations[0], role: 'community_manager' }]])
    assert.ok(isDemo(restoreWorkspace(JSON.stringify({ ...state, invitations, revision: 5 }))));
  for (const raw of ['{', 'null', '{}']) assert.ok(isDemo(restoreWorkspace(raw)));
});
for (const role of ['community_manager', 'worker', 'client'] as Role[]) test(`permisos de Equipo e invitaciones: ${role}`, () => {
  for (const action of ['viewTeam', 'manageInvitations', 'manageTeamAccess'] as const) assert.equal(can(role, action), role === 'community_manager');
  const f = fixture(); success(f.store.actions.setRole(role));
  if (role === 'community_manager') success(f.store.actions.createInvitation(input));
  else {
    for (const attempt of [() => f.store.actions.createInvitation(input), () => f.store.actions.revokeInvitation('x'),
      () => f.store.actions.renewInvitation('x'), () => f.store.actions.removeWorkerCompanyAccess('ana', 'company-0'), () => f.store.actions.listInvitations()])
      unchanged(f, attempt, 'forbidden');
  }
});
test('administrador no gestiona ni lee invitaciones ni acepta con sesión activa', () => {
  const f = ready(); f.setAdmin(true);
  for (const attempt of [() => f.store.actions.createInvitation(input), () => f.store.actions.revokeInvitation(f.invitation.id),
    () => f.store.actions.renewInvitation(f.invitation.id), () => f.store.actions.removeWorkerCompanyAccess('ana', 'company-0'), () => f.store.actions.listInvitations()])
    unchanged(f, attempt, 'forbidden');
  unchanged(f, () => f.store.actions.acceptInvitation(f.invitation.code, { email: ' NUEVA@example.cl ', name: 'Nueva' }), 'session_active');
});
for (const days of [undefined, 1, 7, 30] as const) test(`vigencia ${days ?? 'predeterminada'}`, () => {
  const f = fixture(), i = success(f.store.actions.createInvitation({ ...input, validityDays: days })).invitations[0];
  assert.equal(i.validityDays, days ?? 7); assert.equal(Date.parse(i.expiresAt) - Date.parse(i.createdAt), (days ?? 7) * 86400000);
  assert.equal(invitationStatus(i, Date.parse(i.expiresAt) - 1), 'pendiente');
  assert.equal(invitationStatus(i, Date.parse(i.expiresAt)), 'vencida');
});
for (const patch of [{ validityDays: 0 }, { validityDays: 2 }, { validityDays: 31 }, { role: 'community_manager' }, { email: '' }])
  test(`entrada inválida ${JSON.stringify(patch)}`, () => { const f = fixture(); unchanged(f, () => f.store.actions.createInvitation({ ...input, ...patch } as InvitationInput), 'invalid_input'); });
for (const companyIds of [[], ['missing']]) test(`empresas inválidas ${companyIds}`, () => {
  const f = fixture(); unchanged(f, () => f.store.actions.createInvitation({ ...input, companyIds }), 'invalid_companies');
});
test('códigos aleatorios únicos de 128 bits, enlace solo con código y aceptación de un uso en una escritura', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) success(f.store.actions.createInvitation(input));
  const invitations = f.store.getState().invitations;
  assert.equal(new Set(invitations.map(i => i.code)).size, 12);
  assert.ok(invitations.every(i => /^[a-f0-9]{32}$/.test(i.code)));
  success(f.store.actions.logout()); const before = f.storage.writes.length, platform = structuredClone(f.platform);
  const s = success(f.store.actions.acceptInvitation(invitations[0].code, { email: ' NUEVA@example.cl ', name: ' Nueva Persona ' }));
  assert.equal(f.storage.writes.slice(before).filter(k => k === key).length, 1);
  const user = s.users.at(-1)!;
  assert.equal(user.name, 'Nueva Persona'); assert.equal(user.email, 'nueva@example.cl'); assert.equal(user.example, false);
  assert.deepEqual(s.memberships.filter(m => m.userId === user.id).map(m => m.companyId), input.companyIds);
  assert.equal(invitationStatus(s.invitations[0]), 'usada'); assert.equal(s.authenticated, false);
  assert.deepEqual(f.platform, platform);
  unchanged(f, () => f.store.actions.acceptInvitation(invitations[0].code, { email: ' NUEVA@example.cl ', name: 'Otra' }), 'used');
  unchanged(f, () => f.store.actions.acceptInvitation(invitations[1].code, { email: ' NUEVA@example.cl ', name: 'Otra' }), 'existing_member');
});
for (const cause of ['missing', 'expired', 'revoked', 'used', 'organization_suspended', 'organization_missing', 'company_removed', 'session', 'email', 'platform_email', 'name'] as const)
  test(`aceptación rechazada sin consumo ni registros parciales: ${cause}`, () => {
    const f = ready(); let code = f.invitation.code, expected: WorkspaceError = 'not_found';
    if (cause === 'missing') code = 'missing';
    if (cause === 'expired') { f.setNow(Date.parse(f.invitation.expiresAt)); expected = 'expired'; }
    if (cause === 'revoked') { success(f.store.actions.login()); success(f.store.actions.revokeInvitation(f.invitation.id)); success(f.store.actions.logout()); expected = 'revoked'; }
    if (cause === 'used') { success(f.store.actions.acceptInvitation(code, { email: ' NUEVA@example.cl ', name: 'Nueva' })); expected = 'used'; }
    if (cause === 'organization_suspended') { f.platform.organizations.find(o => o.id === f.invitation.organizationId)!.status = 'suspended'; expected = 'organization_unavailable'; }
    if (cause === 'organization_missing') { f.platform.organizations = []; expected = 'organization_unavailable'; }
    if (cause === 'session') { success(f.store.actions.login()); expected = 'session_active'; }
    if (cause === 'platform_email') { f.platform.members[0].email = ' NUEVA@EXAMPLE.CL '; expected = 'duplicate_email'; }
    if (cause === 'name') expected = 'invalid_input';
    if (cause === 'company_removed' || cause === 'email') {
      const s = structuredClone(f.store.getState()); s.revision++;
      if (cause === 'company_removed') { s.companies = s.companies.filter(c => c.id !== 'company-1'); expected = 'invalid_companies'; }
      else { s.users[0].email = ' NUEVA@EXAMPLE.CL '; expected = 'existing_member'; }
      f.storage.setItem(key, JSON.stringify(s)); f.store.refresh();
    }
    unchanged(f, () => f.store.actions.acceptInvitation(code, { email: ' NUEVA@example.cl ', name: cause === 'name' ? '' : 'Nueva' }), expected);
  });
test('reinvitación de miembro suspendido conserva identidad, rol y suspensión', () => {
  const s = { ...generateDemo(), authenticated: true }; s.users.find(u => u.id === 'ana')!.email = 'NUEVA@example.cl';
  const f = fixture(s); f.platform.memberAccess.push({ organizationId: s.organization.id, userId: 'ana', status: 'suspended' });
  const before = structuredClone(f.platform);
  unchanged(f, () => f.store.actions.createInvitation(input), 'existing_member');
  assert.deepEqual(f.platform, before); assert.equal(f.store.getState().users.length, 4);
});
test('renovar revoca código anterior; revocar y renovar validan vigencia, rol y empresas', () => {
  const f = fixture(), old = success(f.store.actions.createInvitation(input)).invitations[0];
  unchanged(f, () => f.store.actions.renewInvitation(old.id, 2 as 7), 'invalid_input');
  const next = success(f.store.actions.renewInvitation(old.id, 30));
  assert.equal(invitationStatus(next.invitations[0]), 'revocada'); assert.notEqual(next.invitations[1].code, old.code);
  assert.equal(next.invitations[1].validityDays, 30);
  success(f.store.actions.logout()); unchanged(f, () => f.store.actions.acceptInvitation(old.code, { email: ' NUEVA@example.cl ', name: 'Nueva' }), 'revoked');
});
test('retirada conserva contenido y responsable anterior; CM puede reasignar con validación', () => {
  const f = fixture(), s = f.store.getState(), post = s.posts.find(p => p.companyId === 'company-0' && p.responsibleId === 'ana')!;
  const next = success(f.store.actions.removeWorkerCompanyAccess('ana', 'company-0'));
  assert.deepEqual(next.posts, s.posts); assert.deepEqual(next.comments, s.comments);
  assert.equal(isResponsibleAuthorized(next, 'company-0', 'ana'), false);
  const affected = selectPostsWithUnauthorizedResponsible(next, 'company-0').find(p => p.post.id === post.id)!;
  assert.equal(affected.previousResponsible?.name, 'Ana Torres');
  const failed = f.store.actions.updatePost(post.id, post); assert.ok(!failed.ok); assert.match(failed.reason, /responsable autorizado/);
  for (const attempt of [() => f.store.actions.changeStatus(post.id, 'Subido'), () => f.store.actions.addComment(post.id, 'Hola'), () => f.store.actions.deletePost(post.id)]) assert.equal(attempt().ok, false);
  const fixed = success(f.store.actions.updatePost(post.id, { ...post, responsibleId: 'edison' }));
  assert.deepEqual(fixed.comments, s.comments);
  unchanged(f, () => f.store.actions.removeWorkerCompanyAccess('roger', 'company-0'), 'invalid_input');
});
test('dos instancias obsoletas: escrituras reejecutadas conservan ambas empresas y sesión local', () => {
  const f = fixture(), b = createWorkspaceStore(f.storage, f.options);
  success(b.actions.setActiveUser('pablo')); success(f.store.actions.createCompany('Primera', '#fff'));
  b.refresh(); assert.equal(b.getState().activeUserId, 'pablo'); assert.equal(b.getState().role, 'worker');
  success(b.actions.setRole('community_manager')); success(b.actions.createCompany('Segunda', '#fff'));
  f.store.refresh(); assert.ok(f.store.getState().companies.some(c => c.name === 'Primera')); assert.ok(f.store.getState().companies.some(c => c.name === 'Segunda'));
  success(b.actions.logout()); f.store.refresh(); assert.equal(f.store.getState().authenticated, true);
});
test('aceptación simultánea intercalada sobre dos instancias: solo una gana y no hay duplicados', () => {
  const f = ready(), b = createWorkspaceStore(f.storage, f.options); let competing: Result | undefined;
  f.storage.hook = (writtenKey, raw) => {
    if (writtenKey !== `${key}:lock` || !JSON.parse(raw).expiresAt) return;
    f.storage.hook = undefined; competing = b.actions.acceptInvitation(f.invitation.code, { email: ' NUEVA@example.cl ', name: 'B' });
  };
  success(f.store.actions.acceptInvitation(f.invitation.code, { email: ' NUEVA@example.cl ', name: 'A' })); error(competing!, 'conflict');
  error(b.actions.acceptInvitation(f.invitation.code, { email: ' NUEVA@example.cl ', name: 'B' }), 'used');
  assert.equal(b.getState().users.filter(u => u.email === 'nueva@example.cl').length, 1);
  assert.equal(b.getState().memberships.length, generateDemo().memberships.length + 2);
});
test('lease ocupado rechaza; lease expirado se recupera; verificación final detecta interferencia', () => {
  const f = fixture(); f.storage.data.set(`${key}:lock`, JSON.stringify({ token: 'otro', expiresAt: Date.parse('2026-10-22') }));
  unchanged(f, () => f.store.actions.createInvitation(input), 'conflict');
  f.storage.data.set(`${key}:lock`, JSON.stringify({ token: 'abandonado', expiresAt: 1 })); success(f.store.actions.createInvitation(input));
  f.storage.hook = writtenKey => { if (writtenKey === key) f.storage.data.set(`${key}:lock`, JSON.stringify({ token: 'interferencia', expiresAt: Date.parse('2026-10-22') })); };
  error(f.store.actions.createCompany('Interferencia', '#fff'), 'conflict');
});
test('storage/focus/visibility conservan sesión local y normalizan empresa/persona eliminadas; dispose', () => {
  const f = fixture(), windowTarget = new EventTarget(), documentTarget = new EventTarget();
  const b = createWorkspaceStore(f.storage, { ...f.options, windowTarget, documentTarget }); success(b.actions.setActiveUser('ana'));
  for (const [target, type] of [[windowTarget, 'storage'], [windowTarget, 'focus'], [documentTarget, 'visibilitychange']] as const) {
    success(f.store.actions.createCompany(type, '#fff'));
    const event = new Event(type); Object.defineProperty(event, 'key', { value: key }); target.dispatchEvent(event);
    assert.equal(b.getState().activeUserId, 'ana'); assert.equal(b.getState().authenticated, true);
    assert.ok(b.getState().companies.some(c => c.name === type));
  }
  const s = structuredClone(b.getState()); s.companies = s.companies.filter(c => c.id !== 'company-0'); s.revision++;
  f.storage.setItem(key, JSON.stringify(s)); b.refresh(); assert.equal(b.getState().activeCompanyId, 'company-1');
  s.users = s.users.filter(u => u.id !== 'ana'); s.revision++;
  f.storage.setItem(key, JSON.stringify(s)); b.refresh(); assert.equal(b.getState().authenticated, false);
  b.dispose(); const before = b.getState(); success(f.store.actions.createCompany('Después', '#fff')); windowTarget.dispatchEvent(new Event('focus')); assert.equal(b.getState(), before);
});
test('directorio nuevo sin correos vinculados, invitaciones, códigos ni conteos; reconciliación solo huérfanos', () => {
  const f = ready(), s = success(f.store.actions.acceptInvitation(f.invitation.code, { email: ' NUEVA@example.cl ', name: 'Nueva' }));
  const directory = workspaceDirectory(s), resolved = resolveDirectory(f.platform, directory, s.organization.id);
  assert.deepEqual(resolved.members.at(-1), { userId: s.users.at(-1)!.id, name: 'Nueva', role: 'worker', example: false });
  for (const value of [directory, resolved]) assert.doesNotMatch(JSON.stringify(value), /invitations|posts|comments|email|nueva@example|planned|pending|code/);
  assert.equal(reconcileWithDirectory(f.platform, s.users.map(u => u.id)), f.platform);
  f.platform.memberAccess.push({ organizationId: s.organization.id, userId: 'huérfano', status: 'suspended' });
  const next = reconcileWithDirectory(f.platform, s.users.map(u => u.id));
  assert.ok(!next.memberAccess.some(m => m.userId === 'huérfano')); assert.ok(!next.memberAccess.some(m => m.userId === s.users.at(-1)!.id));
});
test('almacenamiento no disponible no informa éxito ni deja cambios en memoria', () => {
  const f = fixture(), s = createWorkspaceStore(undefined, f.options), before = s.getState();
  error(s.actions.acceptInvitation('x', { email: ' NUEVA@example.cl ', name: 'Nueva' }), 'storage_unavailable'); assert.equal(s.getState(), before);
});

for (const email of ['nueva@example.cl', '  NUEVA@EXAMPLE.CL  ']) test(`aceptación exige correo normalizado: ${email}`, () => {
  const f = ready();
  const next = success(f.store.actions.acceptInvitation(f.invitation.code, { name: 'Persona', email }));
  assert.equal(next.users.at(-1)!.email, 'nueva@example.cl');
});
for (const email of ['otra@example.cl', '', 'inválido', undefined]) test(`correo rechazado sin consumo: ${email}`, () => {
  const f = ready();
  const attempt = () => f.store.actions.acceptInvitation(f.invitation.code, { name: 'Persona', email: email as string });
  unchanged(f, attempt, email === 'otra@example.cl' ? 'email_mismatch' : 'invalid_input');
  const result = attempt(); assert.ok(!result.ok);
  assert.ok(!result.reason.includes(f.invitation.email));
  assert.equal(f.storage.writes.filter(k => k === key).length, 2); // Crear y cerrar sesión.
});
for (const status of ['pendiente', 'vencida', 'revocada', 'usada'] as const) test(`renovación desde ${status}, una escritura y código anterior inutilizable`, () => {
  const f = fixture(), old = success(f.store.actions.createInvitation(input)).invitations[0];
  if (status === 'vencida') f.setNow(Date.parse(old.expiresAt));
  if (status === 'revocada') {
    const writes = f.storage.writes.filter(k => k === key).length;
    success(f.store.actions.revokeInvitation(old.id));
    assert.equal(f.storage.writes.filter(k => k === key).length, writes + 1);
  }
  if (status === 'usada') {
    success(f.store.actions.logout());
    success(f.store.actions.acceptInvitation(old.code, { name: 'Persona', email: input.email }));
    success(f.store.actions.login());
    unchanged(f, () => f.store.actions.renewInvitation(old.id, 1), 'used'); return;
  }
  const writes = f.storage.writes.filter(k => k === key).length;
  const next = success(f.store.actions.renewInvitation(old.id, 1));
  assert.equal(f.storage.writes.filter(k => k === key).length, writes + 1);
  const renewed = next.invitations.at(-1)!;
  assert.notEqual(renewed.code, old.code);
  assert.equal(renewed.role, old.role); assert.deepEqual(renewed.companyIds, old.companyIds);
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(renewed.createdAt), 86400000);
  assert.equal(invitationStatus(next.invitations[0]), 'revocada');
  success(f.store.actions.logout());
  unchanged(f, () => f.store.actions.acceptInvitation(old.code, { name: 'Persona', email: input.email }), 'revoked');
  success(f.store.actions.acceptInvitation(renewed.code, { name: 'Persona', email: input.email }));
});
for (const operation of ['crear', 'renovar', 'aceptar'] as const) test(`miembro suspendido con correo normalizado no cambia identidad ni plataforma al ${operation}`, () => {
  const f = fixture(), old = success(f.store.actions.createInvitation(input)).invitations[0];
  if (operation === 'aceptar') success(f.store.actions.logout());
  const state = structuredClone(f.store.getState());
  state.users.find(u => u.id === 'ana')!.email = ' NUEVA@EXAMPLE.CL ';
  state.revision++; f.storage.setItem(key, JSON.stringify(state)); f.store.refresh();
  f.platform.memberAccess.push({ organizationId: state.organization.id, userId: 'ana', status: 'suspended' });
  const platform = structuredClone(f.platform), writes = f.storage.writes.length;
  unchanged(f, () => operation === 'crear' ? f.store.actions.createInvitation(input)
    : operation === 'renovar' ? f.store.actions.renewInvitation(old.id)
      : f.store.actions.acceptInvitation(old.code, { name: 'Otra', email: input.email }), 'existing_member');
  assert.deepEqual(f.platform, platform);
  assert.ok(f.storage.writes.slice(writes).every(k => k === `${key}:lock`));
});
test('orden de validación: entorno antes de correo, coincidencia antes de miembro y nombre', () => {
  const f = ready(), state = structuredClone(f.store.getState());
  state.users[0].email = input.email; state.revision++;
  f.storage.setItem(key, JSON.stringify(state)); f.store.refresh();
  unchanged(f, () => f.store.actions.acceptInvitation(f.invitation.code, { name: '', email: 'otro@example.cl' }), 'email_mismatch');
  unchanged(f, () => f.store.actions.acceptInvitation(f.invitation.code, { name: '', email: input.email }), 'existing_member');
  f.platform.organizations = [];
  unchanged(f, () => f.store.actions.acceptInvitation(f.invitation.code, { name: '', email: '' }), 'organization_unavailable');
});
