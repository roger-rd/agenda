import { ConstraintRegistry, UniqueEntry, CheckEntry } from './constraint-registry';

// Solo restricciones inequívocas de entrada; se excluyen claves derivadas y checks internos.
export const SCHEMA_CONSTRAINTS: readonly (UniqueEntry | CheckEntry)[] = [
  { kind: 'unique', name: 'UQ_users_email', field: 'email', code: 'conflict', message: 'El email ya está registrado.' },
  { kind: 'unique', name: 'UQ_organizations_name_key', field: 'name', code: 'conflict', message: 'El nombre de organización ya está registrado.' },
  { kind: 'unique', name: 'UQ_companies_org_name_key', field: 'name', code: 'conflict', message: 'El nombre de empresa ya está registrado.' },
  // Open-invitation index (a unique index, not a table constraint); the service already translates it to the same code.
  { kind: 'unique', name: 'UQ_invitations_open_email', field: 'email', code: 'invitation_pending_exists', message: 'Ya existe una invitación pendiente para ese correo. Renuévala o revócala antes de crear otra.' },
  { kind: 'check', name: 'CK_users_email', field: 'email', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_users_name', field: 'name', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_organizations_name', field: 'name', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_companies_name', field: 'name', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_companies_color', field: 'color', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_posts_title', field: 'title', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_posts_description', field: 'description', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_posts_format', field: 'format', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_posts_status', field: 'status', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_posts_instagram_url', field: 'instagramUrl', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_invitations_email', field: 'email', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_invitations_role', field: 'role', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
  { kind: 'check', name: 'CK_post_comments_body', field: 'body', origin: 'input', code: 'invalid_input', message: 'El campo indicado no es válido.' },
];
export function registerSchemaConstraints(registry: ConstraintRegistry): ConstraintRegistry {
  for (const entry of SCHEMA_CONSTRAINTS) registry.register(entry);
  return registry;
}
