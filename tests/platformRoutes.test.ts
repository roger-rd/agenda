import './workspaceStorage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute } from '../src/auth/routeGuard';
import { selectActiveSession, closeConflictingSessions, type ActiveSession } from '../src/auth/activeSession';
import { createAdminSession, adminSession, SESSION_KEY } from '../src/platform/session';
import { PLATFORM_ADMIN_ID } from '../src/platform/ids';
import { PLATFORM_NAVIGATION, PLATFORM_ROUTES, isPlatformHome, isOrganizationsRoute } from '../src/platform/routes';
import { actions, getState } from '../src/store';
import { enterPlatformAdmin, logoutAll } from '../src/auth/sessions';
import { workspaceDirectory } from '../src/platform/directory';
import type { AdminSession } from '../src/platform/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
const routes = ['/plataforma/organizaciones/org-1', '/plataforma/organizaciones/org-1/', '/plataforma/organizaciones/x/y', '/plataforma/ORGANIZACIONES', '/empresas/', '/empresa/company-0/','/plataforma/organizaciones', '/plataforma/organizaciones/', '/plataforma/organizaciones/loquesea', '/plataforma/organizaciones?q=bruma&estado=activas', '/', '/plataforma', '/plataforma/x', '/empresas', '/empresa/company-0',
  '/ruta-desconocida', '/plataforma/', '/PLATAFORMA', '/Plataforma/x', '/EMPRESAS',
  '/plataforma-falsa', '/plataforma/X', '/empresa', '/empresas/otra'];
for (const session of ['none', 'workspace', 'platform_admin'] as const) {
  for (const route of routes) {
    for (const suffix of ['', '?dato=privado', '#seccion', '?dato=privado#seccion']) {
      const url = route + suffix;
      test(`guarda ${session}: ${url}`, () => {
        const expected = session === 'none'
          ? { view: 'login', ...(url !== '/' ? { redirectTo: '/' } : {}) }
          : session === 'workspace'
            ? { view: 'workspace', ...(route.toLowerCase().startsWith('/plataforma') ? { redirectTo: '/empresas' } : {}) }
            : { view: 'platform', ...((route === '/plataforma' || route.startsWith('/plataforma/')) ? {} : { redirectTo: '/plataforma' }) };
        assert.deepEqual(resolveRoute(session, url), expected);
      });
    }
  }
}
test('selector excluyente: cuatro combinaciones y limpieza solo del conflicto', () => {
  for (const [workspace, session, expected] of [
    [false, null, 'none'], [true, null, 'workspace'], [false, admin, 'platform_admin'], [true, admin, 'none'],
  ] as const) {
    let closed = 0;
    assert.equal(selectActiveSession(workspace, session), expected);
    closeConflictingSessions(workspace, session, () => { closed++; });
    assert.equal(closed, workspace && session ? 1 : 0);
  }
});
test('suscripción administrativa: snapshots estables, notificaciones y desuscripción', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const session = createAdminSession(storage);
  let count = 0;
  const unsubscribe = session.subscribe(() => { count++; });
  session.setSession(admin);
  const snapshot = session.getSession();
  assert.equal(count, 1);
  session.setSession({ ...admin });
  assert.equal(session.getSession(), snapshot);
  assert.equal(count, 1);
  assert.deepEqual(createAdminSession(storage).getSession(), admin); // Recarga en misma pestaña.
  assert.equal(createAdminSession().getSession(), null); // Otra área de sesión.
  session.setSession(null);
  assert.equal(count, 2);
  assert.equal(data.get(SESSION_KEY), 'null');
  unsubscribe(); session.setSession(admin);
  assert.equal(count, 2);
  const unavailable = createAdminSession({ getItem: () => { throw Error(); }, setItem: () => { throw Error(); } });
  let notified = false;
  unavailable.subscribe(() => { notified = true; });
  unavailable.setSession(admin);
  assert.equal(notified, true);
  assert.deepEqual(unavailable.getSession(), admin);
});
test('login → trabajo → administrador → salida; sin permisos acumulados y conflicto fail-closed', () => {
  const active = (): ActiveSession => selectActiveSession(getState().authenticated, adminSession.getSession());
  try {
    logoutAll();
    assert.equal(active(), 'none');
    actions.login();
    assert.equal(active(), 'workspace');
    assert.equal(adminSession.getSession(), null);
    enterPlatformAdmin();
    assert.equal(getState().authenticated, false);
    assert.equal(active(), 'platform_admin');
    assert.deepEqual(resolveRoute(active(), '/empresa/company-0'), { view: 'platform', redirectTo: '/plataforma' });
    logoutAll();
    assert.deepEqual(resolveRoute(active(), '/plataforma'), { view: 'login', redirectTo: '/' });
    enterPlatformAdmin(); actions.login();
    assert.equal(adminSession.getSession(), null);
    assert.equal(active(), 'workspace');
    // Inyección deliberada de una inconsistencia por fuera del coordinador.
    adminSession.setSession(admin);
    assert.equal(active(), 'none');
    closeConflictingSessions(getState().authenticated, adminSession.getSession(), logoutAll);
    assert.equal(getState().authenticated, false);
    assert.equal(adminSession.getSession(), null);
  } finally { logoutAll(); }
});
test('navegación solo a rutas implementadas, 404 interna y barra final', () => {
  assert.deepEqual(PLATFORM_NAVIGATION.map(item => item.label), ['Panel', 'Organizaciones']);
  for (const { href } of PLATFORM_NAVIGATION) {
    assert.ok(Object.values(PLATFORM_ROUTES).includes(href));
    assert.equal(isPlatformHome(href) || isOrganizationsRoute(href), true);
  }
  assert.equal(isPlatformHome('/plataforma/'), true);
  assert.equal(isOrganizationsRoute('/plataforma/organizaciones/loquesea'), false);
  assert.equal(isOrganizationsRoute('/plataforma/organizaciones/'), true);
  for (const path of ['/plataforma/x', '/plataforma/X', '/plataforma//', '/PLATAFORMA']) assert.equal(isPlatformHome(path), false);
});
test('adaptador de directorio expone exclusivamente los tres metadatos permitidos', () => {
  const directory = workspaceDirectory(getState());
  assert.deepEqual(Object.keys(directory).sort(), ['companies', 'organization', 'users']);
  assert.equal(directory.organization, getState().organization);
});
