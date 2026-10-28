const secrets = new Map<string, number>();

export function registerSecret(value: string): () => void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) return () => {};
  if (!secrets.has(value) && secrets.size >= 32) throw new Error('Registro de secretos lleno.');
  secrets.set(value, (secrets.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = secrets.get(value) ?? 0;
    if (count <= 1) secrets.delete(value);
    else secrets.set(value, count - 1);
  };
}

export function scrubText(text: string, max = 500): string {
  // Primero los más largos para no dejar sufijos de secretos solapados.
  for (const secret of [...secrets.keys()].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[REDACTED]@')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)(?:Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 500;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function activeSecretCount(): number { return secrets.size; }
export function resetSecretsForTests(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Reinicio de secretos permitido solo en pruebas.');
  secrets.clear();
}
