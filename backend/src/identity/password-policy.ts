export type PreparedPassword =
  | { ok: true; value: string }
  | { ok: false; reason: 'type' | 'unicode' | 'nul' | 'length' };

/** NFC sin recortar espacios; los límites se expresan en puntos de código. */
export function preparePassword(input: unknown): PreparedPassword {
  if (typeof input !== 'string') return { ok: false, reason: 'type' };
  // Node >=24 ofrece el método; el proyecto conserva los tipos ES2023.
  if (!(input as string & { isWellFormed(): boolean }).isWellFormed()) return { ok: false, reason: 'unicode' };
  if (input.includes('\u0000')) return { ok: false, reason: 'nul' };
  const value = input.normalize('NFC');
  const length = [...value].length;
  if (length < 15 || length > 128) return { ok: false, reason: 'length' };
  return { ok: true, value };
}
