import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy } from '../src/platform/access';
import { workspaceDirectory } from '../src/platform/directory';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { selectCompanies, selectCompany, selectPosts, responsibleLabel } from '../src/store/selectors';
import { can } from '../src/store/permissions';
import { companyAccess } from '../src/store/teamAccess';
import { accessDraft, accessLabel, draftValidity, recoverAccessDraft, retainedContent, retentionText } from '../src/features/team/teamPresentation';
import { validateDraft } from '../src/features/posts/validation';
import { zonedFormat } from '../src/lib/dates';
import type { Result } from '../src/store/operations';
function success(r: Result) { assert.ok(r.ok, r.ok ? '' : r.reason); return r.state; }
function fixture() {
  const state = { ...generateDemo(), authenticated: true }, platform = generatePlatformSeed();
  const data = new Map([[WORKSPACE_KEY, JSON.stringify(state)]]), writes: string[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v); } };
  let admin = false;
  const options = { getPlatform: () => workspacePolicy(platform), hasAdminSession: () => admin };
  const store = createWorkspaceStore(storage, options);
  return { state, platform, data, writes, storage, options, store, setAdmin: () => { admin = true; } };
}
for (const role of ['worker', 'client'] as const) {
  test(`${role}: asignación, retirada final y lotes idempotentes conservan persona y contenido`, () => {
    const f = fixture(), user = f.state.users.find(u => u.role === role)!;
    const content = JSON.stringify([f.state.posts, f.state.comments]);
    const ids = ['company-0', 'company-2'];
    success(f.store.actions.setCompanyAccess(user.id, ids));
    assert.equal(f.writes.filter(k => k === WORKSPACE_KEY).length, 1);
    const revision = f.store.getState().revision;
    success(f.store.actions.assignCompanyAccess(user.id, ids[0]));
    success(f.store.actions.setCompanyAccess(user.id, [...ids, ids[0]]));
    success(f.store.actions.removeCompanyAccess(user.id, 'company-1'));
    assert.equal(f.store.getState().revision, revision);
    assert.equal(f.writes.filter(k => k === WORKSPACE_KEY).length, 1);
    success(f.store.actions.setCompanyAccess(user.id, []));
    const empty = f.store.getState();
    assert.equal(accessLabel(empty, user.id), 'Sin empresas asignadas');
    assert.deepEqual(empty.users, f.state.users);
    success(f.store.actions.assignCompanyAccess(user.id, 'company-0'));
    assert.deepEqual(companyAccess(f.store.getState(), user.id), ['company-0']);
    assert.equal(JSON.stringify([f.store.getState().posts, f.store.getState().comments]), content);
    const memberships = f.store.getState().memberships;
    assert.equal(new Set(memberships.map(m => m.id)).size, memberships.length);
  });
  test(`${role}: dos pestañas, lecturas tras refresh y seis escrituras sin refresh`, () => {
    const attempts = ['create', 'update', 'status', 'comment', 'delete', 'company'] as const;
    for (const attempt of attempts) {
      const f = fixture(), user = f.state.users.find(u => u.role === role)!;
      success(f.store.actions.setCompanyAccess(user.id, ['company-0']));
      const b = createWorkspaceStore(f.storage, f.options);
      success(b.actions.setActiveUser(user.id)); success(b.actions.setCompany('company-0'));
      const post = b.getState().posts.find(p => p.companyId === 'company-0' && p.visible_para_cliente)!;
      success(f.store.actions.removeCompanyAccess(user.id, 'company-0'));
      const before = f.storage.getItem(WORKSPACE_KEY);
      const actions = { create: () => b.actions.createPost(post), update: () => b.actions.updatePost(post.id, post),
        status: () => b.actions.changeStatus(post.id, 'Subido'), comment: () => b.actions.addComment(post.id, 'Nuevo'),
        delete: () => b.actions.deletePost(post.id), company: () => b.actions.setCompany('company-0') };
      assert.equal(actions[attempt]().ok, false, attempt);
      assert.equal(f.storage.getItem(WORKSPACE_KEY), before);
      b.refresh();
      assert.deepEqual(selectCompanies(b.getState()), []);
      assert.equal(selectCompany(b.getState(), 'company-0'), undefined);
      assert.deepEqual(selectPosts(b.getState(), 'company-0'), []);
      assert.equal(b.getState().activeCompanyId, '');
      b.dispose(); f.store.dispose();
    }
    const f = fixture(), b = createWorkspaceStore(f.storage, f.options);
    success(b.actions.setRole(role)); success(f.store.actions.setCompanyAccess(b.getState().activeUserId, ['company-1']));
    b.refresh(); assert.equal(b.getState().activeCompanyId, 'company-1');
  });
  test(`${role}: no ve Equipo ni gestiona accesos`, () => {
    const f = fixture(); success(f.store.actions.setRole(role));
    assert.equal(can(role, 'viewTeam'), false);
    for (const run of [() => f.store.actions.assignCompanyAccess('ana', 'company-0'), () => f.store.actions.removeCompanyAccess('ana', 'company-0'), () => f.store.actions.setCompanyAccess('ana', [])]) {
      const before = f.storage.getItem(WORKSPACE_KEY); assert.equal(run().ok, false); assert.equal(f.storage.getItem(WORKSPACE_KEY), before);
    }
  });
}
test('rechaza CM como objetivo, persona inexistente, empresa ajena, sin sesión y administrador', () => {
  const f = fixture();
  const manager = f.state.users.find(u => u.role === 'community_manager')!;
  for (const [user, ids] of [[manager.id, []], ['missing', []], ['ana', ['missing']]] as [string, string[]][]) {
    const before = f.storage.getItem(WORKSPACE_KEY); assert.equal(f.store.actions.setCompanyAccess(user, ids).ok, false); assert.equal(f.storage.getItem(WORKSPACE_KEY), before);
  }
  assert.equal(accessLabel(f.state, manager.id), 'Todas las empresas');
  success(f.store.actions.logout()); assert.equal(f.store.actions.setCompanyAccess('ana', []).ok, false);
  success(f.store.actions.login()); f.setAdmin(); assert.equal(f.store.actions.setCompanyAccess('ana', []).ok, false);
});
test('conteos separados por empresa, autor y asignación; cliente solo comentarios; sin enlaces', () => {
  const f = fixture(), s = f.state, post = s.posts.find(p => p.companyId === 'company-0')!;
  s.posts = [{ ...post, id: 'a', responsibleId: 'ana' }, { ...post, id: 'b', responsibleId: 'otro' }, { ...post, id: 'c', companyId: 'company-1', responsibleId: 'ana' }];
  s.comments = ['a', 'b', 'c'].flatMap(postId => ['ana', 'roger', 'otro'].map(authorId => ({ id: postId + authorId, postId, authorId, body: 'Conservar', createdAt: new Date().toISOString() })));
  const rows = retainedContent(s, 'ana', ['company-0', 'company-1']);
  assert.deepEqual(rows.map(r => [r.posts, r.comments]), [[1, 2], [1, 1]]);
  assert.equal(retainedContent(s, 'roger', ['company-0'])[0].posts, undefined);
  assert.equal(retainedContent(s, 'roger', ['company-0'])[0].comments, 2);
  assert.match(retentionText(rows, true), /Se conservaron 1 publicaciones y 2 comentarios/);
  assert.doesNotMatch(readFileSync('src/features/team/Team.tsx', 'utf8'), /href=|<Link|publicacion=/);
});
test('suspensión: política booleana, sin metadatos ni escrituras en plataforma', () => {
  const f = fixture();
  f.platform.memberAccess.push({ organizationId: f.state.organization.id, userId: 'ana', status: 'suspended', suspension: { reason: 'privado', at: new Date().toISOString() } });
  const before = JSON.stringify(f.platform);
  success(f.store.actions.setCompanyAccess('ana', [])); success(f.store.actions.assignCompanyAccess('ana', 'company-0'));
  assert.equal(workspacePolicy(f.platform).memberSuspended(f.state.organization.id, 'ana'), true);
  assert.equal(JSON.stringify(f.platform), before);
  assert.ok(f.writes.every(k => k === WORKSPACE_KEY || k === `${WORKSPACE_KEY}:lock`));
  assert.doesNotMatch(JSON.stringify(workspacePolicy(f.platform)), /reason|at|privado/);
  assert.doesNotMatch(JSON.stringify(workspaceDirectory(f.store.getState())), /invitations|posts|comments/);
});
test('responsable anterior inválido conserva identidad; validación de formulario y operación exigen autorizado', () => {
  const f = fixture(), post = f.state.posts.find(p => p.responsibleId === 'ana')!;
  success(f.store.actions.removeCompanyAccess('ana', post.companyId));
  const s = f.store.getState();
  assert.match(responsibleLabel(s, post.companyId, 'ana'), /Ana.*\(sin acceso\)/);
  const draft = { ...post, day: zonedFormat(post.scheduledAt, 'yyyy-MM-dd'), time: zonedFormat(post.scheduledAt, 'HH:mm') };
  assert.match(validateDraft(draft, s).responsibleId!, /autorizado/);
  assert.equal(f.store.actions.updatePost(post.id, post).ok, false);
  assert.equal(s.posts.find(p => p.id === post.id)!.responsibleId, 'ana');
});
test('conflicto conserva selección y refresca antes de habilitar reintento manual', () => {
  const f = fixture(), draft = { ...accessDraft(f.state, 'ana'), selected: ['company-2'], ready: false };
  success(f.store.actions.assignCompanyAccess('ana', 'company-2'));
  const before = f.storage.getItem(WORKSPACE_KEY);
  const conflict = f.store.actions.setCompanyAccess('ana', draft.selected, f.state.revision);
  assert.ok(!conflict.ok && conflict.code === 'conflict');
  assert.equal(f.storage.getItem(WORKSPACE_KEY), before);
  for (const code of ['conflict', 'storage_unavailable'] as const) {
    let refreshed = false;
    const next = recoverAccessDraft(draft, { ok: false, code, reason: 'Reintenta' }, () => { assert.equal(draft.ready, false); refreshed = true; });
    assert.equal(refreshed, true); assert.equal(next.ready, true); assert.deepEqual(next.selected, draft.selected);
    assert.equal(draftValidity(f.store.getState(), 'ana', next).changed, true);
    assert.equal(draftValidity({ ...f.state, companies: [] }, 'ana', next).valid, false);
    assert.equal(draftValidity({ ...f.state, users: [] }, 'ana', next).valid, false);
  }
});

test('si falla la lectura de refresco, no habilita Reintentar', () => {
  const f = fixture(), draft = accessDraft(f.state, 'ana');
  const next = recoverAccessDraft(draft, { ok: false, code: 'storage_unavailable', reason: 'Sin almacenamiento' }, () => false);
  assert.equal(next.ready, false); assert.deepEqual(next.selected, draft.selected);
});

test('refresh independiente revoca lecturas sin ejecutar acciones, trabajador y cliente', () => {
  for (const role of ['worker', 'client'] as const) {
    const f = fixture(), b = createWorkspaceStore(f.storage, f.options);
    success(b.actions.setRole(role)); success(b.actions.setCompany('company-0'));
    const userId = b.getState().activeUserId;
    success(f.store.actions.setCompanyAccess(userId, []));
    assert.ok(selectCompany(b.getState(), 'company-0'));
    assert.equal(b.refresh(), true);
    assert.deepEqual(selectCompanies(b.getState()), []); assert.deepEqual(selectPosts(b.getState(), 'company-0'), []);
    assert.equal(selectCompany(b.getState(), 'company-0'), undefined); assert.equal(b.getState().activeCompanyId, '');
  }
});

test('empresa existente de otra organización rechazada sin escritura', () => {
  const f = fixture();
  f.data.set(WORKSPACE_KEY, JSON.stringify({ ...f.state, companies: [...f.state.companies, { id: 'ajena', name: 'Ajena', color: '#fff', organizationId: 'otra' }] }));
  f.store.refresh();
  const before = f.storage.getItem(WORKSPACE_KEY);
  assert.equal(f.store.actions.assignCompanyAccess('ana', 'ajena').ok, false);
  assert.equal(f.store.actions.setCompanyAccess('ana', ['company-0', 'ajena']).ok, false);
  assert.equal(f.storage.getItem(WORKSPACE_KEY), before);
});

test('las vistas reciben nombres sin acceso sin modificar los usuarios ni las publicaciones', () => {
  const f = fixture(); success(f.store.actions.removeCompanyAccess('ana', 'company-0'));
  const s = f.store.getState(), before = JSON.stringify(s);
  const users = s.users.map(user => ({ ...user, name: responsibleLabel(s, 'company-0', user.id) }));
  assert.equal(users.find(u => u.id === 'ana')!.name, 'Ana Torres (sin acceso)');
  assert.equal(users.find(u => u.id === 'edison')!.name, s.users.find(u => u.id === 'edison')!.name);
  assert.equal(JSON.stringify(s), before);
  assert.match(readFileSync('src/features/calendar/Calendar.tsx', 'utf8'), /name: responsibleLabel\(state, companyId, user.id\)/);
});
