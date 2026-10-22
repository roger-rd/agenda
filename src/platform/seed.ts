import { LINKED_ORGANIZATION_ID, WORKSPACE_USER_IDS } from './ids';
import type { PlatformState } from './types';
export const EXAMPLE_DATA_NOTICE = 'Datos de ejemplo';
export function generatePlatformSeed(): PlatformState {
  // Mediodía en Santiago: evita que la fecha de ejemplo retroceda al día anterior.
  const createdAt = '2026-01-01T15:00:00.000Z';
  const examples = ['Bruma Estudio', 'Taller Lucero', 'Nube Austral'];
  return {
    version: 1, revision: 0,
    organizations: [
      { id: LINKED_ORGANIZATION_ID, name: 'Estudio Creativo', status: 'active', createdAt, workspaceLinked: true },
      ...examples.map((name, i) => ({ id: `example-org-${i}`, name: `${name} (datos de ejemplo)`,
        status: i === 2 ? 'suspended' as const : 'active' as const, createdAt, workspaceLinked: false,
        ...(i === 2 ? { suspension: { at: createdAt, reason: 'Suspensión de ejemplo' } } : {}) })),
    ],
    // Estos directorios pertenecen a organizaciones que no existen en el espacio de trabajo.
    members: examples.map((_, i) => ({ id: `example-member-${i}`, organizationId: `example-org-${i}`,
      name: `Responsable ${i + 1} (datos de ejemplo)`, email: `responsable${i}@example.invalid`,
      role: 'community_manager', example: true })),
    companies: examples.map((_, i) => ({ id: `example-company-${i}`, organizationId: `example-org-${i}`,
      name: `Empresa ${i + 1} (datos de ejemplo)`, color: '#5753c9', example: true })),
    memberAccess: [
      ...Object.values(WORKSPACE_USER_IDS).map(userId => ({ organizationId: LINKED_ORGANIZATION_ID, userId, status: 'active' as const })),
      ...examples.map((_, i) => ({ organizationId: `example-org-${i}`, userId: `example-member-${i}`,
        status: i === 0 ? 'suspended' as const : 'active' as const,
        ...(i === 0 ? { suspension: { at: createdAt, reason: 'Suspensión individual de ejemplo' } } : {}) })),
    ],
  };
}
