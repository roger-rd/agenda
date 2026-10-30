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

const codes = (word: string): Uint8Array => Uint8Array.from(word, ch => ch.charCodeAt(0));
const group = (words: string[], auth = false) => ({ w: words.map(codes), auth: words.map(word => Number(auth && word.toLowerCase() === 'authorization')) });
const TAB = {
  P: group(['password', 'passwd', 'pwd', 'passphrase', 'privatekey', 'private_key', 'private-key']),
  PC: group(['Password', 'Passwd', 'Pwd', 'Passphrase', 'PrivateKey']),
  S: group(['secret']), SC: group(['Secret']), T: group(['token']), TC: group(['Token']),
  A: group(['apikey', 'api_key', 'api-key', 'authorization'], true), AC: group(['ApiKey', 'Authorization'], true),
};
const ACCESS = codes('access'), KEY = codes('key'), HASH = codes('hash'), BEARER = codes('bearer');
const FIRST_K = Uint8Array.from({ length: 128 }, (_, i) => Number('pPsStTaA'.includes(String.fromCharCode(i))));
const FIRST_B = Uint8Array.from({ length: 128 }, (_, i) => Number(i === 98 || i === 66));

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 5760 ||
    (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
    code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function isAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function matchCI(text: string, start: number, word: Uint8Array): boolean {
  for (let k = 0; k < word.length; k++) {
    const c = text.charCodeAt(start + k), g = word[k];
    if (g >= 97 ? (c | 0x20) !== g : c !== g) return false;
  }
  return true;
}
function matchExact(text: string, start: number, word: Uint8Array): boolean {
  for (let k = 0; k < word.length; k++) if (text.charCodeAt(start + k) !== word[k]) return false;
  return true;
}
function tryGroup(text: string, start: number, g: typeof TAB.P, exact: boolean): number {
  for (let k = 0; k < g.w.length; k++) {
    const w = g.w[k];
    if (exact ? matchExact(text, start, w) : matchCI(text, start, w)) return (start + w.length) * 2 + g.auth[k];
  }
  return -1;
}
function keyAt(text: string, start: number, c0: number): number {
  const camel = start > 0 && isAlnum(text.charCodeAt(start - 1));
  switch (c0) {
    case 112: case 80: return tryGroup(text, start, camel ? TAB.PC : TAB.P, camel);
    case 115: case 83: return tryGroup(text, start, camel ? TAB.SC : TAB.S, camel);
    case 116: case 84: return tryGroup(text, start, camel ? TAB.TC : TAB.T, camel);
    case 97: case 65: return tryGroup(text, start, camel ? TAB.AC : TAB.A, camel);
    default: return -1;
  }
}
function suffixEnd(text: string, start: number): number {
  let i = start;
  if (text.charCodeAt(i) === 95 || text.charCodeAt(i) === 45) i++;
  if (matchCI(text, i, ACCESS)) {
    i += 6;
    if (text.charCodeAt(i) === 95 || text.charCodeAt(i) === 45) i++;
  }
  if (matchCI(text, i, KEY)) return i + 3;
  if (matchCI(text, i, HASH)) return i + 4;
  return start;
}
function valueStart(text: string, start: number): number {
  let i = start;
  while (i < start + 3 && text.charCodeAt(i) === 92) i++;
  if (text.charCodeAt(i) === 34 || text.charCodeAt(i) === 39) i++;
  while (isSpace(text.charCodeAt(i))) i++;
  if (text.charCodeAt(i) !== 61 && text.charCodeAt(i) !== 58) return -1;
  i++;
  while (isSpace(text.charCodeAt(i))) i++;
  return i;
}
type Scan = { tf: number; tt: number; lf: number; lt: number; os: number; oe: number; cs: number; ce: number };
// S4: no hay delimitadores dentro del tramo memorizado; todo inicio interior comparte fin.
function tokenEnd(text: string, x: Scan, start: number): number {
  if (start >= x.tf && start < x.tt) return x.tt;
  let i = start;
  while (i < text.length && !isSpace(text.charCodeAt(i)) && text.charCodeAt(i) !== 44 && text.charCodeAt(i) !== 59) i++;
  x.tf = start; x.tt = i;
  return i;
}
function lineEnd(text: string, x: Scan, start: number): number {
  if (start >= x.lf && start < x.lt) return x.lt;
  let i = start;
  while (i < text.length && text.charCodeAt(i) !== 13 && text.charCodeAt(i) !== 10) i++;
  x.lf = start; x.lt = i;
  return i;
}
function quotedEnd(text: string, x: Scan, start: number, openingEnd: number): number {
  const quote = text.charCodeAt(openingEnd), escaped = openingEnd > start;
  let i = openingEnd + 1, slashes = 0;
  x.os = start; x.oe = i; x.cs = -1; x.ce = -1;
  // S5: cada iteración avanza; los recorridos de una misma clase de comilla son disjuntos.
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (escaped) {
      if ((code === 34 || code === 39) && slashes > 0) {
        x.cs = i - Math.min(3, slashes); x.ce = i + 1;
        return tokenEnd(text, x, i + 1);
      }
      slashes = code === 92 ? slashes + 1 : 0; i++;
    } else {
      if (code === quote) { x.cs = i; x.ce = i + 1; return i + 1; }
      i += code === 92 ? 2 : 1;
    }
  }
  return text.length;
}
function valueAt(text: string, x: Scan, start: number, auth: boolean): number {
  let i = start;
  while (i < start + 3 && text.charCodeAt(i) === 92) i++;
  if (text.charCodeAt(i) === 34 || text.charCodeAt(i) === 39) return quotedEnd(text, x, start, i);
  x.os = 0; x.oe = 0; x.cs = -1; x.ce = -1;
  if (auth) return lineEnd(text, x, start);
  let end: number;
  if (matchCI(text, start, BEARER) && isSpace(text.charCodeAt(start + 6))) {
    let token = start + 6;
    while (isSpace(text.charCodeAt(token))) token++;
    end = tokenEnd(text, x, token);
    if (end === token) end = tokenEnd(text, x, start);
  } else end = tokenEnd(text, x, start);
  return end === start ? -1 : end;
}
function bearerEnd(text: string, x: Scan, start: number): number {
  const previous = text.charCodeAt(start - 1);
  // S10: equivale a límite de palabra ASCII + Bearer + espacios JS + token no vacío.
  if ((start > 0 && (isAlnum(previous) || previous === 95)) || !matchCI(text, start, BEARER) || !isSpace(text.charCodeAt(start + 6))) return -1;
  let token = start + 6;
  while (isSpace(text.charCodeAt(token))) token++;
  const end = tokenEnd(text, x, token);
  return end > token ? end : -1;
}
function emitIntervals(text: string, kl: number[], bl: number[]): string {
  const out: string[] = [];
  let copied = 0, a = 0, b = 0;
  let have = false, rs = 0, re = 0, pk = 0, pe = 0, pos = 0, poe = 0, pcs = -1, pce = -1;
  const flush = () => {
    if (!have) return;
    // S6–S7: copiado crece, sin repetir slices; el primario conserva el cierre solo sin exceso.
    out.push(text.slice(copied, rs));
    out.push(pk === 1 ? 'Bearer [REDACTED]' : text.slice(pos, poe) + '[REDACTED]' + (re === pe && pcs >= 0 ? text.slice(pcs, pce) : ''));
    copied = re; have = false;
  };
  while (a < kl.length || b < bl.length) {
    let s: number, e: number, kind: number, o1 = 0, o2 = 0, c1 = -1, c2 = -1;
    if (b >= bl.length || (a < kl.length && kl[a] <= bl[b])) {
      s = kl[a]; e = kl[a + 1]; kind = 0;
      o1 = kl[a + 2]; o2 = kl[a + 3]; c1 = kl[a + 4]; c2 = kl[a + 5]; a += 6;
    } else { s = bl[b]; e = bl[b + 1]; kind = 1; b += 2; }
    if (have && s <= re) { if (e > re) re = e; }
    else { flush(); have = true; rs = s; re = e; pk = kind; pe = e; pos = o1; poe = o2; pcs = c1; pce = c2; }
  }
  flush(); out.push(text.slice(copied));
  return out.join('');
}
function redactIntervals(text: string): string {
  // S9: toda cola exige = o :; el prefiltro no puede eliminar una clave válida.
  const hasSep = text.indexOf('=') >= 0 || text.indexOf(':') >= 0;
  const x: Scan = { tf: -1, tt: -1, lf: -1, lt: -1, os: 0, oe: 0, cs: -1, ce: -1 };
  let kl: number[] | undefined, bl: number[] | undefined;
  // S1–S2, S8: avance unitario, tablas disjuntas, sin regex ni recursión; listas solo al detectar.
  // S3 (O1): dentro de palabra/sufijo no cabe otra clave camel completa; tras _/-
  // solo queda access/key/hash. Cola y espacios tampoco inician claves. Por ello
  // i2 >= v1 y v2 > v1; las listas ya están ordenadas y se fusionan sin ordenar.
  for (let i = 0; i < text.length; i++) {
    const c0 = text.charCodeAt(i);
    if (c0 >= 128) continue;
    if (hasSep && FIRST_K[c0]) {
      const kw = keyAt(text, i, c0);
      if (kw >= 0) {
        const auth = kw & 1, kend = kw >> 1;
        const v = valueStart(text, auth ? kend : suffixEnd(text, kend));
        if (v >= 0) {
          const e = valueAt(text, x, v, auth === 1);
          if (e >= 0) (kl ??= []).push(v, e, x.os, x.oe, x.cs, x.ce);
        }
      }
    } else if (FIRST_B[c0]) {
      const e = bearerEnd(text, x, i);
      if (e >= 0) (bl ??= []).push(i, e);
    }
  }
  return kl || bl ? emitIntervals(text, kl ?? [], bl ?? []) : text;
}

export function scrubText(text: string, max = 500, budget?: RecordBudget): string {
  if (text.length > MAX_SCRUB_INPUT) return CADENA_LARGA;
  if (RecordBudget.is(budget) && !budget.consume(text.length)) return LIMITE_PRESUPUESTO;
  // Primero los más largos para no dejar sufijos de secretos solapados.
  for (const secret of [...secrets.keys()].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  // S9: el patrón exige :// literal; sin él, replace es la identidad.
  if (text.indexOf('://') >= 0) text = text.replace(/(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[REDACTED]@');
  // P1 no garantiza JSON válido; el saneamiento estructurado queda fuera de alcance.
  text = redactIntervals(text);
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 500;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function activeSecretCount(): number { return secrets.size; }
export function resetSecretsForTests(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Reinicio de secretos permitido solo en pruebas.');
  secrets.clear();
}
