import './workspaceStorage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformStore, PLATFORM_KEY } from '../src/platform/store';
import { createAdminSession, adminSession, SESSION_KEY } from '../src/platform/session';
import { createSessionCoordinator, enterPlatformAdmin, enterWorkspace, leaveWorkspace, leaveAdmin, logoutAll } from '../src/auth/sessions';
import { generatePlatformSeed } from '../src/platform/seed';
import { generateDemo } from '../src/data/demo';
import { PLATFORM_ADMIN_ID, LINKED_ORGANIZATION_ID as linked } from '../src/platform/ids';
import { actions, getState } from '../src/store';
import { platformCan } from '../src/platform/permissions';
import { savePost, deletePost, setStatus, addComment } from '../src/store/operations';
import { changePostStatus } from '../src/store/transitions';
import { selectCompany } from '../src/store/selectors';
import type { AdminSession } from '../src/platform/types';
import type { Role } from '../src/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
class MemoryStorage {
  data = new Map<string, string>(); writes: string[] = []; fail = false;
  getItem(key: string) { if (this.fail) throw new Error('No disponible'); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail) throw new Error('No disponible'); this.writes.push(key); this.data.set(key, value); }
}
const input = { name: 'Nueva Organización', managerName: 'Responsable Nuevo', email: 'nuevo@example.invalid' };

test('acciones y coordinador conservan las transiciones de las sesiones reales y su orden', () => {
  const originalSetSession = adminSession.setSession;
  const checkWorkspace = (authenticated: boolean) => {
    assert.equal(getState().authenticated, authenticated);
    assert.equal(getState().role, 'community_manager');
  };
  adminSession.setSession = session => {
    // Comprobar el estado justo antes de abrir administración, no solo al terminar.
    if (session) checkWorkspace(false);
    originalSetSession(session);
  };
  try {
    for (const login of [actions.login, enterWorkspace]) {
      enterPlatformAdmin();
      login(); checkWorkspace(true); assert.equal(adminSession.getSession(), null);
      actions.setRole('worker');
      login(); checkWorkspace(true);
      for (const logout of [actions.logout, leaveWorkspace]) {
        actions.setRole('client');
        logout(); checkWorkspace(false); assert.equal(adminSession.getSession(), null);
        login();
      }
      actions.setRole('worker');
      enterPlatformAdmin(); checkWorkspace(false); assert.deepEqual(adminSession.getSession(), admin);
      leaveWorkspace(); checkWorkspace(false); assert.deepEqual(adminSession.getSession(), admin);
      actions.logout(); checkWorkspace(false); assert.deepEqual(adminSession.getSession(), admin);
      leaveAdmin(); checkWorkspace(false); assert.equal(adminSession.getSession(), null);
      login(); actions.setRole('worker');
      const before = getState(); leaveAdmin(); assert.equal(getState(), before);
      logoutAll(); checkWorkspace(false); assert.equal(adminSession.getSession(), null);
      enterPlatformAdmin(); logoutAll(); checkWorkspace(false); assert.equal(adminSession.getSession(), null);
    }
  } finally { adminSession.setSession = originalSetSession; logoutAll(); }
});

test('dos pestañas: lectura fresca antes de escribir, acceso, eventos, notificaciones y cleanup', () => {
  const storage = new MemoryStorage(), windowTarget = new EventTarget(), documentTarget = new EventTarget();
  const a = createPlatformStore(storage, { getSession: () => admin });
  const b = createPlatformStore(storage, { getSession: () => admin, windowTarget, documentTarget });
  let notices = 0; const unsubscribe = b.subscribe(() => notices++);
  try {
    assert.ok(a.suspendOrganization({ organizationId: linked, reason: 'Privado' }).ok);
    assert.equal(b.getState().revision, 0);
    assert.ok(b.createOrganization(input).ok);
    assert.equal(b.getState().revision, 2);
    assert.deepEqual(b.isAccessAllowed(linked, 'ana'), { allowed: false, code: 'organization_suspended' });
    assert.ok(a.reactivateOrganization({ organizationId: linked }).ok);
    assert.equal(a.getState().revision, 3); assert.equal(a.getState().organizations.length, 5);
    const event = new Event('storage'); Object.defineProperty(event, 'key', { value: PLATFORM_KEY });
    windowTarget.dispatchEvent(event);
    assert.deepEqual(b.isAccessAllowed(linked, 'ana'), { allowed: true });
    assert.equal(b.getState().revision, 3);
    const n = notices; b.refresh(); assert.equal(notices, n);
    a.suspendMember({ organizationId: linked, userId: 'ana' }); windowTarget.dispatchEvent(new Event('focus'));
    assert.equal(b.getState().revision, 4);
    a.reactivateMember({ organizationId: linked, userId: 'ana' }); documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(b.getState().revision, 5);
    a.suspendOrganization({ organizationId: linked });
    assert.deepEqual(b.isAccessAllowed(linked, 'ana'), { allowed: false, code: 'organization_suspended' });
    unsubscribe(); const n2 = notices;
    a.reactivateOrganization({ organizationId: linked }); b.refresh(); assert.equal(notices, n2);
    b.dispose(); a.suspendOrganization({ organizationId: linked }); windowTarget.dispatchEvent(event);
    assert.equal(b.getState().revision, 7);
    assert.ok(storage.writes.every(key => key === PLATFORM_KEY));
  } finally { a.dispose(); b.dispose(); }
});

test('fallos conservan cambios en memoria y exponen aviso; corrupción no lanza', () => {
  const storage = new MemoryStorage(), store = createPlatformStore(storage, { getSession: () => admin });
  try {
    storage.fail = true;
    assert.ok(store.suspendOrganization({ organizationId: linked }).ok);
    const state = store.getState(); store.refresh(); assert.equal(store.getState(), state);
    assert.ok(store.getStorageWarning());
    storage.fail = false; store.refresh(); assert.equal(store.getState(), state);
    assert.ok(store.suspendMember({ organizationId: linked, userId: 'ana' }).ok);
    assert.equal(store.getStorageWarning(), ''); assert.equal(store.getState().revision, 2);
    for (const raw of ['{', 'null', '{"version":7}', '{"version":1,"revision":0}']) {
      storage.data.set(PLATFORM_KEY, raw); store.refresh(); assert.deepEqual(store.getState(), generatePlatformSeed());
      const restored = createPlatformStore(storage); assert.deepEqual(restored.getState(), generatePlatformSeed()); restored.dispose();
    }
  } finally { store.dispose(); }
  const unavailable = createPlatformStore(undefined, { getSession: () => admin });
  assert.ok(unavailable.createOrganization(input).ok); assert.ok(unavailable.getStorageWarning()); unavailable.dispose();
});

test('sesiones inyectadas son excluyentes, reinician rol y persisten solo en almacenamiento de pestaña', () => {
  const storage = new MemoryStorage(), session = createAdminSession(storage);
  let workspace = { authenticated: true, role: 'worker' as Role };
  const coordinator = createSessionCoordinator({ admin: session, setWorkspace: (authenticated, role) => {
    workspace = { authenticated, role }; assert.ok(!(authenticated && session.getSession()));
  } });
  coordinator.enterPlatformAdmin(); assert.equal(workspace.authenticated, false); assert.equal(workspace.role, 'community_manager');
  assert.deepEqual(session.getSession(), admin);
  assert.deepEqual(createAdminSession(storage).getSession(), admin);
  assert.equal(createAdminSession(new MemoryStorage()).getSession(), null);
  coordinator.enterWorkspace(); assert.equal(workspace.authenticated, true); assert.equal(session.getSession(), null);
  coordinator.leaveWorkspace(); assert.equal(workspace.authenticated, false);
  coordinator.enterPlatformAdmin(); coordinator.leaveAdmin(); assert.equal(session.getSession(), null);
  coordinator.enterPlatformAdmin(); coordinator.logoutAll(); assert.equal(session.getSession(), null); assert.equal(workspace.authenticated, false);
  assert.ok(storage.writes.every(k => k === SESSION_KEY));
  storage.data.set(SESSION_KEY, '{'); assert.equal(createAdminSession(storage).getSession(), null);
  storage.data.set(SESSION_KEY, JSON.stringify({ ...admin, adminId: 'roger' })); assert.equal(createAdminSession(storage).getSession(), null);
  storage.fail = true; const memory = createAdminSession(storage); memory.setSession(admin); assert.deepEqual(memory.getSession(), admin); memory.setSession(null);
});

test('sesiones reales: administrador sin escrituras de trabajo; roles no conceden administración', () => {
  const storage = new MemoryStorage(), platform = createPlatformStore(storage);
  try {
    enterWorkspace(); actions.setRole('worker'); enterPlatformAdmin();
    assert.equal(getState().authenticated, false); assert.equal(getState().role, 'community_manager');
    const before = getState(), snapshot = JSON.stringify(before), post = before.posts[0];
    const writes = [() => actions.createPost(post), () => actions.updatePost(post.id, post), () => actions.deletePost(post.id),
      () => actions.changeStatus(post.id, 'Subido'), () => actions.addComment(post.id, 'Comentario'), () => actions.createCompany('Empresa', '#fff'),
      () => actions.reset(), () => actions.setRole('worker'), () => actions.setCompany('company-1')];
    for (const write of writes) { const result = write(); assert.ok(!result.ok); assert.ok(result.reason); assert.equal(getState(), before); assert.equal(JSON.stringify(getState()), snapshot); }
    for (const result of [savePost(before, post), savePost(before, post, post.id), deletePost(before, post.id), setStatus(before, post.id, 'Subido'), addComment(before, post.id, 'Texto')]) assert.ok(!result.ok);
    assert.equal(changePostStatus(before, post.id, 'Subido'), before);
    assert.ok(platform.createOrganization(input).ok);
    enterWorkspace();
    const platformBefore = platform.getState();
    for (const role of ['community_manager', 'worker', 'client'] as const) {
      actions.setRole(role); assert.equal(platformCan(adminSession.getSession(), 'createOrganization'), false);
      for (const result of [platform.createOrganization(input), platform.suspendOrganization({ organizationId: linked }), platform.reactivateOrganization({ organizationId: linked }),
        platform.suspendMember({ organizationId: linked, userId: 'ana' }), platform.reactivateMember({ organizationId: linked, userId: 'ana' }), platform.resetPlatform(),
        platform.listOrganizations(getState()), platform.viewOrganization(linked, getState())]) {
        assert.ok(!result.ok); assert.equal(result.code, 'no_admin_session'); assert.equal(platform.getState(), platformBefore);
      }
    }
    const beforeRole = getState(); assert.ok(!actions.setRole('platform_admin' as Role).ok); assert.equal(getState(), beforeRole);
    for (const organization of platform.getState().organizations.filter(o => !o.workspaceLinked)) {
      assert.equal(selectCompany(getState(), organization.id), undefined);
      assert.equal(actions.createPost({ ...post, companyId: organization.id }).ok, false);
    }
  } finally { logoutAll(); platform.dispose(); }
});

test('claves y restablecimientos independientes mantienen referencias y suspensiones', () => {
  const storage = new MemoryStorage(); const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const platform = createPlatformStore(storage, { getSession: () => admin });
  try {
    enterWorkspace(); actions.reset();
    assert.ok(storage.writes.every(k => k === 'agenda-demo-v2'));
    const workspaceBefore = getState(), serialized = storage.data.get('agenda-demo-v2');
    platform.createOrganization(input); platform.suspendOrganization({ organizationId: linked }); platform.suspendMember({ organizationId: linked, userId: 'ana' });
    assert.equal(getState(), workspaceBefore); assert.equal(storage.data.get('agenda-demo-v2'), serialized);
    const platformBefore = JSON.stringify(platform.getState()), persisted = storage.data.get(PLATFORM_KEY);
    const cursor = storage.writes.length; actions.reset();
    assert.ok(storage.writes.slice(cursor).every(k => k === 'agenda-demo-v2'));
    assert.equal(JSON.stringify(platform.getState()), platformBefore); assert.equal(storage.data.get(PLATFORM_KEY), persisted);
    assert.deepEqual(platform.isAccessAllowed(linked, 'ana'), { allowed: false, code: 'organization_suspended' });
    assert.ok(getState().users.every(u => platform.getState().memberAccess.some(a => a.organizationId === linked && a.userId === u.id)));
    const workspaceAfter = getState(); assert.ok(platform.resetPlatform().ok); assert.equal(getState(), workspaceAfter);
    assert.ok(platform.getState().organizations.some(o => o.id === linked));
    assert.equal(platform.getState().organizations.length, generatePlatformSeed().organizations.length);
    assert.equal(generateDemo().organization.id, linked);
  } finally {
    logoutAll(); platform.dispose();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});


test('almacén sin sesión: cada operación rechaza sin escribir ni incrementar revisión', () => {
  const storage = new MemoryStorage();
  const store = createPlatformStore(storage, { getSession: () => null });
  const before = store.getState();
  try {
    for (const operation of [() => store.createOrganization(input),
      () => store.suspendOrganization({ organizationId: linked }),
      () => store.reactivateOrganization({ organizationId: linked }),
      () => store.suspendMember({ organizationId: linked, userId: 'ana' }),
      () => store.reactivateMember({ organizationId: linked, userId: 'ana' }), store.resetPlatform]) {
      const result = operation();
      assert.ok(!result.ok); assert.equal(result.code, 'no_admin_session');
      assert.equal(store.getState(), before); assert.equal(store.getState().revision, before.revision);
      assert.equal(storage.writes.length, 0);
    }
  } finally { store.dispose(); }
});
