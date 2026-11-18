import { normalizePersonName, organizationNameKey } from '../identity/person-name';

export function normalizeCompanyName(input: unknown): { name: string; nameKey: string } | null {
  const name = normalizePersonName(input);
  if (name === null) return null;
  const nameKey = organizationNameKey(name);
  return nameKey === null ? null : { name, nameKey };
}

export function normalizeCompanyColor(input: unknown): string | null {
  return typeof input === 'string' && /^#[0-9a-fA-F]{6}(?![\s\S])/.test(input) ? input.toLowerCase() : null;
}
