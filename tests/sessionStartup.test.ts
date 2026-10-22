import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { PLATFORM_ADMIN_ID } from '../src/platform/ids';

test('arranque administrativo con marca compartida de trabajo: sin escrituras; conflicto posterior en memoria sigue cerrando ambas', async () => {
  const workspaceKey = 'agenda-demo-v2', platformKey = 'agenda-platform-v1', sessionKey = 'agenda-platform-session-v1';
  const workspace = { ...generateDemo(), authenticated: true, activeUserId: 'ana', role: 'worker' as const };
  const admin = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID } as const;
  const shared = new Map([[workspaceKey, JSON.stringify(workspace)], [platformKey, JSON.stringify(generatePlatformSeed())]]);
  const tab = new Map([[sessionKey, JSON.stringify(admin)]]);
  const sharedBefore = [...shared], tabBefore = [...tab];
  const writes: string[] = [];
  const storage = (data: Map<string, string>) => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); data.set(key, value); },
  });
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(shared) });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage(tab) });
  try {
    // Importación diferida: prueba el arranque real de los singletons con almacenamiento inyectado.
    const { getState, actions } = await import('../src/store');
    const { adminSession } = await import('../src/platform/session');
    const { selectActiveSession, closeConflictingSessions } = await import('../src/auth/activeSession');
    const { resolveRoute } = await import('../src/auth/routeGuard');
    const { logoutAll } = await import('../src/auth/sessions');
    assert.deepEqual(getState(), { ...workspace, authenticated: false });
    assert.deepEqual(adminSession.getSession(), admin);
    closeConflictingSessions(getState().authenticated, adminSession.getSession(), logoutAll);
    const active = selectActiveSession(getState().authenticated, adminSession.getSession());
    assert.equal(active, 'platform_admin');
    for (const path of ['/plataforma', '/plataforma/organizaciones', '/plataforma/organizaciones/org-1?dato=1#detalle']) {
      assert.deepEqual(resolveRoute(active, path), { view: 'platform' });
    }
    assert.deepEqual(resolveRoute(active, '/empresa/company-0'), { view: 'platform', redirectTo: '/plataforma' });
    assert.deepEqual(writes, []);
    assert.deepEqual([...shared], sharedBefore);
    assert.deepEqual([...tab], tabBefore);
    assert.equal(JSON.parse(shared.get(workspaceKey)!).authenticated, true);
    assert.deepEqual(adminSession.getSession(), admin);

    // Una transición explícita conserva sus efectos habituales.
    actions.login();
    assert.equal(adminSession.getSession(), null);
    assert.equal(getState().authenticated, true);
    // Inconsistencia real introducida en esta pestaña después del arranque.
    adminSession.setSession(admin);
    assert.equal(selectActiveSession(getState().authenticated, adminSession.getSession()), 'none');
    closeConflictingSessions(getState().authenticated, adminSession.getSession(), logoutAll);
    assert.equal(adminSession.getSession(), null);
    assert.equal(getState().authenticated, false);
    assert.equal(JSON.parse(shared.get(workspaceKey)!).authenticated, false);
  } finally {
    for (const [key, descriptor] of [['localStorage', previousLocal], ['sessionStorage', previousSession]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
