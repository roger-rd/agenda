const secrets = new Map<string, number>();

// Umbral en unidades UTF-16; los marcadores no conservan datos del original.
export const MAX_SCRUB_INPUT = 16 * 1024;
export const CADENA_LARGA = '[CADENA_LARGA]';
export const LIMITE_PRESUPUESTO = '[LIMITE]';
export const RECORD_BUDGET_CHARS = 128 * 1024;

// Primitiva que el llamador crea y pasa explícitamente por registro.
export class RecordBudget {
  #remaining: number;
  #exhausted = false;

  constructor(limit = RECORD_BUDGET_CHARS) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Presupuesto inválido.');
    this.#remaining = limit;
    this.#exhausted = limit === 0;
  }

  consume(chars: number): boolean {
    if (this.#exhausted) return false;
    if (!Number.isFinite(chars) || chars < 0 || chars > this.#remaining) {
      this.#exhausted = true;
      return false;
    }
    this.#remaining -= chars;
    this.#exhausted = this.#remaining === 0;
    return true;
  }

  get exhausted(): boolean { return this.#exhausted; }
  get remaining(): number { return this.#remaining; }

  static is(value: unknown): value is RecordBudget {
    return typeof value === 'object' && value !== null && #remaining in value;
  }
}

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

export function scrubText(text: string, max = 500, budget?: RecordBudget): string {
  if (text.length > MAX_SCRUB_INPUT) return CADENA_LARGA;
  if (RecordBudget.is(budget) && !budget.consume(text.length)) return LIMITE_PRESUPUESTO;
  // Primero los más largos para no dejar sufijos de secretos solapados.
  for (const secret of [...secrets.keys()].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[REDACTED]@')
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
