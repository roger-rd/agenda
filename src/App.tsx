import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Navigate, useLocation } from 'react-router';
import { actions, useStore } from './store';
import { currentUserId, workspaceOrganizationId, selectUser } from './store/selectors';
import { platformStore } from './platform/store';
import { accessCausesForWorkspace } from './platform/access';
import { resolveWorkspaceGate } from './features/access/workspaceGate';
import { AccessSuspended } from './features/access/AccessSuspended';
import { useActiveSession } from './auth/useActiveSession';
import { resolveRoute } from './auth/routeGuard';
import { isOrganizationsRoute, organizationDetailId } from './platform/routes';
import { initialRecovery, updateRecovery } from './features/access/recovery';
import { APP_NAME } from './lib/config';
import { Login } from './features/auth/Login';
import { Workspace } from './features/workspace/Workspace';
import { PlatformShell } from './features/platform/PlatformShell';

export function App() {
  const state = useStore();
  const session = useActiveSession();
  const location = useLocation();
  const platform = useSyncExternalStore(platformStore.subscribe, platformStore.getState);
  const userIds = JSON.stringify(state.users.map(u => u.id).sort());
  useEffect(() => { platformStore.reconcileWithWorkspace(JSON.parse(userIds)); }, [userIds]);
  useLayoutEffect(() => { platformStore.refresh(); }, [session, state.role, location.key]);
  const causes = accessCausesForWorkspace(platform, workspaceOrganizationId(state), currentUserId(state));
  const blocked = session === 'workspace' && resolveWorkspaceGate(session, causes).access === 'blocked';
  const [accessTransition, setAccessTransition] = useState(initialRecovery);
  const nextRecovery = updateRecovery(accessTransition, session === 'workspace' ? currentUserId(state) : null, blocked);
  if (nextRecovery !== accessTransition) setAccessTransition(nextRecovery);
  const { view, redirectTo } = resolveRoute(session, location.pathname + location.search + location.hash);
  const pendingFocus = useRef(false);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    if (blocked) document.title = `Acceso suspendido · ${APP_NAME}`;
    else if (view !== 'platform' || !organizationDetailId(location.pathname)) document.title = view === 'platform' ? `${isOrganizationsRoute(location.pathname) ? 'Organizaciones · ' : ''}Administración · ${APP_NAME}` : APP_NAME;
    if (redirectTo) pendingFocus.current = true;
    else if (pendingFocus.current || previousView.current !== view) {
      document.querySelector<HTMLElement>('main[tabindex="-1"]')?.focus({ preventScroll: true });
      pendingFocus.current = false;
    }
    previousView.current = view;
  }, [view, redirectTo, location.key, location.pathname, blocked, accessTransition.restored]);
  if (redirectTo) return <Navigate to={redirectTo} replace />;
  if (view === 'platform') return <PlatformShell />;
  if (blocked) return <AccessSuspended causes={causes} user={selectUser(state)} onRoleChange={actions.setRole} />;
  return view === 'workspace' ? <Workspace key={state.role} accessRestored={accessTransition.restored} focusAfterBlock={accessTransition.returning} /> : <Login />;
}
