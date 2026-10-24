import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy, accessCausesForWorkspace } from '../src/platform/access';
import { inspectInvitation } from '../src/store/invitations';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { selectCompanies, selectDemoGroups } from '../src/store/selectors';
import { resolveWorkspaceGate } from '../src/features/access/workspaceGate';
import { resolveRoute } from '../src/auth/routeGuard';
import { invitationCode } from '../src/platform/routes';
import { acceptanceErrors, acceptanceFields, acceptanceSubmitState } from '../src/features/invitation/invitationPresentation';
import { resolveDirectory, workspaceDirectory, reconcileWithDirectory } from '../src/platform/directory';
import { createPlatformStore, PLATFORM_KEY } from '../src/platform/store';
import { companyAccess } from '../src/store/teamAccess';
const now = Date.parse('2026-10-23T12:00:00Z');
function fixture() {
  const state = generateDemo(), platform = generatePlatformSeed();
  state.authenticated = false;
  state.invitations = [{ id: 'inv', code: 'Abc_123-', organizationId: state.organization.id,
    email: 'privado@example.cl', role: 'client', companyIds: ['company-0'], validityDays: 7,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 1).toISOString() }];
  return { state, platform, ctx: { platform: workspacePolicy(platform), now } };
}
for (const session of ['none', 'workspace', 'platform_admin'] as const)
  for (const path of ['/invitacion', '/invitacion/', '/invitacion/Abc_123-', '/invitacion/Abc_123-/', '/invitacion/' + 'x'.repeat(129), '/invitacion/%20', '/invitacion/a/b', '/invitacion/ñ'])
    for (const suffix of ['', '?x=1', '#x', '?x=1#x'])
      test(`ruta pública ${session} ${path}${suffix}`, () => assert.deepEqual(resolveRoute(session, path + suffix), { view: 'invitation' }));
test('código exacto, límite y mayúsculas de ruta', () => {
  assert.equal(invitationCode('/invitacion/Abc_123-/?x#y'), 'Abc_123-');
  assert.equal(invitationCode('/invitacion/' + 'a'.repeat(128)).length, 128);
  for (const path of ['/invitacion/', '/invitacion/a/b', '/invitacion/%20', '/invitacion/' + 'a'.repeat(129), '/INVITACION/abc'])
    assert.equal(invitationCode(path), '');
  for (const session of ['none', 'workspace', 'platform_admin'] as const)
    assert.notEqual(resolveRoute(session, '/INVITACION/abc').view, 'invitation');
});
test('inspección válida mínima, de solo lectura y sin correo', () => {
  const { state, platform, ctx } = fixture(), before = structuredClone({ state, platform });
  assert.deepEqual(inspectInvitation(state, 'Abc_123-', ctx), { status: 'valid', organization: state.organization.name, role: 'client', companies: [state.companies[0].name] });
  assert.deepEqual({ state, platform }, before);
});
for (const status of ['invalid', 'expired', 'revoked', 'used', 'organization_unavailable', 'companies_unavailable'] as const)
  test(`inspección ${status} devuelve exclusivamente estado`, () => {
    const { state, platform, ctx } = fixture();
    if (status === 'expired') ctx.now++;
    if (status === 'revoked') state.invitations[0].revokedAt = new Date(now).toISOString();
    if (status === 'used') state.invitations[0].usedAt = new Date(now).toISOString();
    if (status === 'organization_unavailable') platform.organizations.find(o => o.id === state.organization.id)!.status = 'suspended';
    if (status === 'companies_unavailable') state.companies = [];
    assert.deepEqual(inspectInvitation(state, status === 'invalid' ? 'missing' : 'Abc_123-', ctx), { status });
  });
test('organización ausente/ajena y códigos mal formados no revelan datos', () => {
  const { state, platform, ctx } = fixture();
  for (const code of ['', 'a/b', 'a'.repeat(129), '%20']) assert.deepEqual(inspectInvitation(state, code, ctx), { status: 'invalid' });
  platform.organizations = [];
  assert.deepEqual(inspectInvitation(state, 'Abc_123-', ctx), { status: 'organization_unavailable' });
  state.invitations[0].organizationId = 'otra';
  assert.deepEqual(inspectInvitation(state, 'Abc_123-', ctx), { status: 'organization_unavailable' });
});
test('aceptar, entrar como persona nueva, cerrar admin y mantener puerta de suspensión', () => {
  const { state, platform } = fixture();
  const code = 'a'.repeat(32); state.invitations[0].code = code;
  const data = new Map([[WORKSPACE_KEY, JSON.stringify(state)]]);
  let writes = 0, admin = false;
  const store = createWorkspaceStore({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); if (k === WORKSPACE_KEY) writes++; } },
    { getPlatform: () => workspacePolicy(platform), now: () => now, hasAdminSession: () => admin, closeAdminSession: () => { admin = false; } });
  const before = structuredClone(platform);
  const accepted = store.actions.acceptInvitation(code, { name: 'Nueva', email: ' PRIVADO@EXAMPLE.CL ' });
  assert.ok(accepted.ok); assert.equal(writes, 1); assert.equal(accepted.state.authenticated, false);
  const user = accepted.state.users.at(-1)!;
  assert.equal(user.email, 'privado@example.cl'); assert.deepEqual(platform, before);
  admin = true;
  assert.ok(store.actions.enterAs(user.id).ok);
  assert.equal(writes, 2); assert.equal(admin, false);
  assert.equal(store.getState().activeUserId, user.id); assert.equal(store.getState().role, 'client');
  assert.deepEqual(selectCompanies(store.getState()).map(c => c.id), ['company-0']);
  platform.memberAccess.push({ organizationId: state.organization.id, userId: user.id, status: 'suspended' });
  assert.ok(store.actions.enterAs(user.id).ok);
  assert.equal(resolveWorkspaceGate('workspace', accessCausesForWorkspace(platform, state.organization.id, user.id)).access, 'blocked');
  assert.ok(store.actions.setActiveUser('ana').ok); assert.equal(store.getState().activeCompanyId, 'company-0');
  assert.ok(store.actions.setActiveUser(user.id).ok);
  assert.equal(resolveWorkspaceGate('workspace', accessCausesForWorkspace(platform, state.organization.id, user.id)).access, 'blocked');
  const raw = data.get(WORKSPACE_KEY);
  assert.equal(store.actions.enterAs('missing').ok, false); assert.equal(data.get(WORKSPACE_KEY), raw);
  const empty = { ...store.getState(), memberships: [], revision: store.getState().revision + 1 };
  data.set(WORKSPACE_KEY, JSON.stringify(empty));
  assert.ok(store.actions.enterAs(user.id).ok); assert.equal(store.getState().activeCompanyId, '');
  assert.deepEqual(selectCompanies(store.getState()), []);
  assert.deepEqual(store.actions.inspectInvitation(code), { status: 'used' });
  store.dispose();
});
test('validación por campo y mapa de todos los rechazos sin correo esperado', () => {
  assert.deepEqual(acceptanceFields(' N ', ' A@B.CL '), { name: '', email: '' });
  assert.ok(acceptanceFields('', 'mal').name); assert.ok(acceptanceFields('n'.repeat(121), 'a'.repeat(121)).email);
  for (const code of ['email_mismatch', 'used', 'revoked', 'expired', 'organization_unavailable', 'invalid_companies', 'existing_member', 'duplicate_email', 'session_active', 'conflict', 'storage_unavailable', 'invalid_input', 'not_found'] as const)
    assert.ok(acceptanceErrors[code]);
});
test('UI conserva borrador tras fallo, refresca, no reintenta automáticamente y exige entrada explícita', () => {
  const page = readFileSync(new URL('../src/features/invitation/InvitationPage.tsx', import.meta.url), 'utf8');
  const failure = page.split('if (!result.ok) {')[1].split('const id =')[0];
  assert.match(failure, /actions.refresh\(\)/); assert.doesNotMatch(failure, /setDraft|acceptInvitation|enterAs/);
  assert.equal([...page.matchAll(/actions.acceptInvitation\(/g)].length, 1);
  assert.match(page, /session !== 'none'/); assert.match(page, /onClick=\{logoutAll\}/);
  assert.match(page, /acceptanceSubmitState\(errorCode, ready\)/); assert.match(page, /disabled=\{submit.disabled\}>\{submit.label\}/); assert.match(page, /onClick=\{enter\}/);
  assert.doesNotMatch(page, /type="password"/);
  const selector = readFileSync(new URL('../src/features/workspace/DemoMode.tsx', import.meta.url), 'utf8');
  assert.match(selector, /selectDemoGroups\(state, actions.memberSuspended\)/);
  assert.doesNotMatch(selector, /disabled=|setRole|reason|suspendedAt/);
});
test('selector agrupa todas las personas nuevas, ordena y solo expone etiquetas públicas', () => {
  const { state } = fixture();
  state.users.push({ id: 'new', name: 'Alicia', role: 'worker', example: false });
  state.activeUserId = 'new';
  const groups = selectDemoGroups(state, id => id === 'new');
  assert.deepEqual(groups.map(g => g.label), ['Community manager', 'Trabajadores', 'Clientes']);
  assert.equal(groups.flatMap(g => g.people).length, state.users.length);
  assert.deepEqual(groups[1].people[0], { id: 'new', label: 'Alicia (persona actual) (acceso suspendido)' });
  assert.ok(groups.flatMap(g => g.people).some(p => p.label.includes('(datos de ejemplo)')));
  assert.doesNotMatch(JSON.stringify(groups), /email|reason|suspendedAt/);
});

const submitLabels = {
  email_mismatch: 'Aceptar invitación', conflict: 'Reintentar', storage_unavailable: 'Reintentar',
  forbidden: 'Aceptar invitación', invalid_input: 'Aceptar invitación', not_found: 'Aceptar invitación',
  used: 'Aceptar invitación', revoked: 'Aceptar invitación', expired: 'Aceptar invitación',
  organization_unavailable: 'Aceptar invitación', invalid_companies: 'Aceptar invitación',
  session_active: 'Aceptar invitación', existing_member: 'Aceptar invitación', duplicate_email: 'Aceptar invitación',
} satisfies Record<import('../src/store/operations').WorkspaceError, string>;
for (const [code, label] of Object.entries(submitLabels))
  test(`envío tras ${code}: etiqueta y bloqueo durante recuperación`, () => {
    for (const ready of [true, false]) assert.deepEqual(
      acceptanceSubmitState(code as keyof typeof submitLabels, ready), { label, disabled: !ready });
  });
test('envío inicial y campos vacíos o inválidos mantienen Aceptar invitación', () => {
  assert.deepEqual(acceptanceSubmitState(), { label: 'Aceptar invitación', disabled: false });
  for (const [name, email] of [['', ''], ['Nombre', 'incorrecto'], ['', 'a@b.cl']]) {
    assert.ok(Object.values(acceptanceFields(name, email)).some(Boolean));
    assert.equal(acceptanceSubmitState('invalid_input').label, 'Aceptar invitación');
  }
});


test('directorio vivo de aceptación y suspensión conservada al gestionar empresas y reconciliar', () => {
  const { state, platform } = fixture();
  const code = 'b'.repeat(32); state.invitations[0].code = code;
  const data = new Map([[WORKSPACE_KEY, JSON.stringify(state)], [PLATFORM_KEY, JSON.stringify(platform)]]);
  const writes: string[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); data.set(k, v); } };
  const platformStore = createPlatformStore(storage);
  const options = { getPlatform: () => { platformStore.refresh(); return workspacePolicy(platformStore.getState()); }, now: () => now };
  const store = createWorkspaceStore(storage, options);
  const observer = createWorkspaceStore(storage, options);
  try {
    const accepted = store.actions.acceptInvitation(code, { name: 'Nueva integrante', email: 'privado@example.cl' });
    assert.ok(accepted.ok);
    const user = accepted.state.users.at(-1)!;
    const expected = { userId: user.id, name: 'Nueva integrante', role: 'client', example: false };
    const directory = () => resolveDirectory(platformStore.getState(), workspaceDirectory(store.getState()), 'org-1');
    assert.deepEqual(directory().members.find(m => m.userId === user.id), expected);
    assert.deepEqual(Object.keys(directory()).sort(), ['companies', 'members']);
    assert.ok(directory().members.every(m => Object.keys(m).sort().join(',') === 'example,name,role,userId'));
    assert.doesNotMatch(JSON.stringify(workspaceDirectory(store.getState())), /email|invitations|code|posts|comments|privado@example/);
    assert.equal(resolveDirectory(platformStore.getState(), workspaceDirectory(observer.getState()), 'org-1').members.some(m => m.userId === user.id), false);
    let notifications = 0;
    observer.subscribe(() => notifications++);
    assert.equal(observer.refresh(), true);
    assert.equal(notifications, 1);
    assert.deepEqual(resolveDirectory(platformStore.getState(), workspaceDirectory(observer.getState()), 'org-1').members.find(m => m.userId === user.id), expected);
    const reloaded = createWorkspaceStore(storage, options);
    assert.deepEqual(resolveDirectory(platformStore.getState(), workspaceDirectory(reloaded.getState()), 'org-1').members.find(m => m.userId === user.id), expected);
    reloaded.dispose();

    platform.memberAccess.push({ organizationId: 'org-1', userId: user.id, status: 'suspended',
      suspension: { at: new Date(now).toISOString(), reason: 'Motivo administrativo privado' } });
    data.set(PLATFORM_KEY, JSON.stringify(platform)); platformStore.refresh();
    const before = structuredClone(platformStore.getState());
    const raw = data.get(PLATFORM_KEY);
    assert.ok(store.actions.login().ok);
    const changes = [
      { run: () => store.actions.setCompanyAccess(user.id, ['company-0', 'company-1']), ids: ['company-0', 'company-1'] },
      { run: () => store.actions.removeCompanyAccess(user.id, 'company-0'), ids: ['company-1'] },
      { run: () => store.actions.assignCompanyAccess(user.id, 'company-0'), ids: ['company-0', 'company-1'] },
      { run: () => store.actions.setCompanyAccess(user.id, []), ids: [] },
      { run: () => store.actions.assignCompanyAccess(user.id, 'company-0'), ids: ['company-0'] },
    ];
    for (const change of changes) {
      assert.equal(workspacePolicy(platformStore.getState()).accessAllowed('org-1', user.id), false);
      assert.ok(change.run().ok);
      assert.deepEqual(companyAccess(store.getState(), user.id).sort(), change.ids);
      assert.deepEqual(platformStore.getState().memberAccess, before.memberAccess);
      assert.deepEqual(platformStore.getState(), before);
      assert.equal(data.get(PLATFORM_KEY), raw);
      assert.equal(writes.includes(PLATFORM_KEY), false);
      assert.equal(workspacePolicy(platformStore.getState()).accessAllowed('org-1', user.id), false);
    }
    const ids = store.getState().users.map(u => u.id);
    assert.deepEqual(reconcileWithDirectory(before, ids).memberAccess, before.memberAccess);
    const orphan = { organizationId: 'org-1', userId: 'inexistente', status: 'suspended' as const,
      suspension: { at: new Date(now).toISOString(), reason: 'Huérfano' } };
    const withOrphan = { ...before, memberAccess: [...before.memberAccess, orphan] };
    assert.deepEqual(reconcileWithDirectory(withOrphan, ids).memberAccess, before.memberAccess);
    assert.deepEqual(withOrphan.memberAccess, [...before.memberAccess, orphan]);
  } finally { store.dispose(); observer.dispose(); platformStore.dispose(); }
});
