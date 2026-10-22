import { organizationQueryString, parseOrganizationQuery } from './organizationRows';
import { PLATFORM_ROUTES } from '../../platform/routes';
import type { PlatformState } from '../../platform/types';
export const WORKSPACE_BLOCKING_NOTICE = 'La suspensión se aplica al espacio de trabajo de demostración en este navegador (simulación local, sin protección real de servidor).';
export function organizationsReturnUrl(search: string) {
  const query = organizationQueryString(parseOrganizationQuery(search));
  return PLATFORM_ROUTES.organizations + (query ? `?${query}` : '');
}
export function individuallySuspendedCount(state: PlatformState, organizationId: string, userIds: string[]) {
  return userIds.filter(id => state.memberAccess.some(a => a.organizationId === organizationId && a.userId === id && a.status === 'suspended')).length;
}
export function organizationConfirmation(name: string, suspend: boolean, total: number, suspended: number) {
  if (suspend) return `Al suspender «${name}», ${total === 1 ? 'su 1 miembro quedará bloqueado' : `sus ${total} miembros quedarán bloqueados`} en esta organización aunque su acceso individual esté activo. Los accesos individuales no cambian y los datos ya guardados se conservan. Los cambios sin guardar se descartan al bloquear el acceso.${total > 0 ? ` ${suspended === 1 ? '1 miembro ya tiene suspensión individual.' : `${suspended} miembros ya tienen suspensión individual.`}` : ''}`;
  return `Al reactivar «${name}», sus miembros recuperan el acceso${suspended ? `, salvo ${suspended === 1 ? 'el 1 que tiene una suspensión individual, que sigue bloqueado' : `los ${suspended} que tienen una suspensión individual, que siguen bloqueados`} hasta que reactives su acceso` : ''}.`;
}
export function memberConfirmation(name: string, organization: string, suspend: boolean, organizationSuspended: boolean) {
  if (suspend) return `Suspender a «${name}» bloquea solo su acceso a «${organization}». No afecta a los demás miembros ni a otras organizaciones, y sus datos ya guardados se conservan. Los cambios sin guardar se descartan al bloquear el acceso.${organizationSuspended ? ' Ya está bloqueado por la organización.' : ''}`;
  return `Al reactivar a «${name}», recupera su acceso individual a «${organization}».${organizationSuspended ? ' Seguirá bloqueado por la organización hasta que la reactives.' : ''}`;
}

export function formatOrganizationDate(value: string) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'America/Santiago' }).format(new Date(value));
}
