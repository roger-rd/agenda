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
