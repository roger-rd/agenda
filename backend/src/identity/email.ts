/** Identidad ASCII únicamente; no implementa equivalencias específicas de proveedores. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
  if (value.length < 3 || value.length > 120 || /[^\x21-\x7e]/.test(value)) return null;
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length < 1 || local.length > 64 || /[^A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => label.length < 1 || label.length > 63 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return null;
  return value.toLowerCase();
}
