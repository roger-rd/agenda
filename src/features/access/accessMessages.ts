import type { WorkspaceAccessCauses } from '../../platform/access';
export const ACCESS_CONTACT = 'Contacta con el administrador de la plataforma.';
export const ACCESS_SIMULATION = 'Simulación local: este bloqueo se aplica solo en este navegador; no hay protección real de servidor.';
export const ACCESS_RESTORED = 'Tu acceso fue restablecido. Los cambios que no se guardaron antes del bloqueo no se recuperan.';
export function accessMessage(causes: WorkspaceAccessCauses): string {
  if (causes.organizationUnknown) return 'La organización no está disponible.';
  if (causes.organizationSuspended && causes.memberSuspended)
    return 'La organización está suspendida y tu acceso individual también. Al reactivar la organización seguirás bloqueado hasta que se reactive tu acceso.';
  if (causes.organizationSuspended) return 'La organización está suspendida. Todos sus miembros están bloqueados.';
  if (causes.memberSuspended) return 'Tu acceso individual está suspendido. El resto de los miembros no se ve afectado.';
  return '';
}
