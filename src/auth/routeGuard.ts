import { recoveryScreen, isInvitationRoute, isPlatformHome, isOrganizationsRoute, organizationDetailId } from '../platform/routes';
import type { ActiveSession } from './activeSession';
export interface RouteResolution { view: 'login' | 'workspace' | 'platform' | 'invitation' | 'recovery'; redirectTo?: string }

// Las rutas son sensibles a mayúsculas. Query/hash no cambian la identidad de ruta.
export function resolveRoute(activeSession: ActiveSession, pathname: string): RouteResolution {
  const path = pathname.split(/[?#]/, 1)[0];
  if (recoveryScreen(path)) {
    if (activeSession === 'none') return { view: 'recovery' };
    return activeSession === 'workspace'
      ? { view: 'workspace', redirectTo: '/' }
      : { view: 'platform', redirectTo: '/plataforma' };
  }
  if (isInvitationRoute(path)) return { view: 'invitation' };
  if (activeSession === 'none') return { view: 'login', ...(pathname !== '/' ? { redirectTo: '/' } : {}) };
  if (activeSession === 'workspace') return {
    view: 'workspace', ...(path.toLowerCase().startsWith('/plataforma') ? { redirectTo: '/empresas' } : {}),
  };
  // Las rutas internas desconocidas permanecen en el panel para mostrar su 404.
  const platform = isPlatformHome(path) || isOrganizationsRoute(path) || !!organizationDetailId(path) || path.startsWith('/plataforma/');
  return { view: 'platform', ...(!platform ? { redirectTo: '/plataforma' } : {}) };
}
