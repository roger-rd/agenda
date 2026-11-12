function collapseSpaces(value: string): string {
  return value.replace(/\p{Z}+/gu, ' ').trim();
}

export function normalizePersonName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // Node >=24 ofrece el método; el proyecto conserva los tipos ES2023.
  if (!(input as string & { isWellFormed(): boolean }).isWellFormed()) return null;
  const normalized = input.normalize('NFC');
  if (/\p{C}/u.test(normalized)) return null;
  const value = collapseSpaces(normalized);
  return [...value].length >= 2 && [...value].length <= 80 ? value : null;
}

/** Solo organizaciones. La equivalencia exacta con los CHECK PostgreSQL
 * (lower, btrim, [[:cntrl:]], char_length) queda pendiente de B2-B. */
export function organizationNameKey(name: string): string | null {
  const value = collapseSpaces(name.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase());
  return [...value].length >= 2 && [...value].length <= 80 ? value : null;
}
