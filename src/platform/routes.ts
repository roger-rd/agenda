export const PLATFORM_ROUTES = { home: '/plataforma', organizations: '/plataforma/organizaciones' } as const;
export const PLATFORM_NAVIGATION = [
  { label: 'Panel', href: PLATFORM_ROUTES.home },
  { label: 'Organizaciones', href: PLATFORM_ROUTES.organizations },
] as const;
export function isPlatformHome(pathname: string) {
  return pathname === PLATFORM_ROUTES.home || pathname === `${PLATFORM_ROUTES.home}/`;
}
export function isOrganizationsRoute(pathname: string) {
  return pathname === PLATFORM_ROUTES.organizations || pathname === `${PLATFORM_ROUTES.organizations}/`;
}
export const ORGANIZATION_DETAIL_PATTERN = /^\/plataforma\/organizaciones\/([A-Za-z0-9_-]{1,80})\/?$/;
export function organizationDetailId(pathname: string) {
  return ORGANIZATION_DETAIL_PATTERN.exec(pathname)?.[1] ?? null;
}

export const INVITATION_PATTERN = /^\/invitacion\/([A-Za-z0-9_-]{1,128})\/?$/;
export const invitationCode = (pathname: string) => INVITATION_PATTERN.exec(pathname.split(/[?#]/, 1)[0])?.[1] ?? '';
export const isInvitationRoute = (path: string) => path === '/invitacion' || path.startsWith('/invitacion/');

export const RECOVERY_ROUTES = {
  request: '/recuperar',
  sent: '/recuperar/enviado',
  reset: '/recuperar/restablecer',
} as const;
export function recoveryScreen(pathname: string) {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/$/, '');
  if (path === RECOVERY_ROUTES.request) return 'request';
  if (path === RECOVERY_ROUTES.sent) return 'sent';
  if (path === RECOVERY_ROUTES.reset) return 'reset';
  return null;
}
