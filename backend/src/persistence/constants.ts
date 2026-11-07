/**
 * Closed vocabulary and SQL fragments shared by the entities and their tests. Values mirror the frontend
 * (src/types/index.ts, src/features/posts/validation.ts); only table and column names are English.
 */
export const ROLES = ['community_manager', 'worker', 'client'] as const;
export const POST_FORMATS = ['Post', 'Carrusel', 'Reel', 'Historia'] as const;
export const POST_STATUSES = ['Pendiente', 'En proceso', 'Completado', 'Subido'] as const;
/** Roles that receive explicit company accesses. The community manager sees every company of the organization. */
export const ACCESS_ROLES = ['worker', 'client'] as const;
export type Role = (typeof ROLES)[number];
export type PostFormat = (typeof POST_FORMATS)[number];
export type PostStatus = (typeof POST_STATUSES)[number];

export const LIMITS = Object.freeze({
  name: Object.freeze({ min: 2, max: 80 }),
  email: Object.freeze({ min: 3, max: 120 }),
  title: Object.freeze({ min: 1, max: 120 }),
  description: 5000,
  comment: Object.freeze({ min: 1, max: 2000 }),
  instagramUrl: 2048,
  passwordHash: Object.freeze({ min: 40, max: 512 }),
  tokenHashBytes: 32,
});

/** Only ever called with the closed constants above: no quote can appear in them. */
export function literals(values: readonly string[]): string {
  if (values.some(value => value.includes("'"))) throw new Error('persistence_literal');
  return values.map(value => `'${value}'`).join(', ');
}
/** Application-generated UUIDv7 in canonical lowercase text: version nibble 7 and RFC 4122 variant. */
export const uuidV7 = (column = 'id') => `substr(${column}::text, 15, 1) = '7' AND substr(${column}::text, 20, 1) IN ('8', '9', 'a', 'b')`;
/** Names are stored trimmed, without doubled spaces or control characters. Unicode folding stays in the service. */
export const cleanName = (column: string, min: number, max: number) =>
  `char_length(${column}) BETWEEN ${min} AND ${max} AND ${column} = btrim(${column}) AND ${column} !~ '  ' AND ${column} !~ '[[:cntrl:]]'`;
export const normalizedKey = (column: string, max: number) =>
  `char_length(${column}) BETWEEN 2 AND ${max} AND ${column} = btrim(${column}) AND ${column} = lower(${column})`;
