import * as registry from './secret-registry';
const { scrubText, resetSecretsForTests, RecordBudget, MAX_SCRUB_INPUT, CADENA_LARGA } = registry;
afterEach(resetSecretsForTests);
// Infinito funcional sin alterar el contrato público heredado de max=Infinity (500).
const clean = (text: string) => scrubText(text, Number.MAX_SAFE_INTEGER);
const URL_RE = /(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi;

// Copia LITERAL del oráculo de scrub-text.regression.spec.ts; no importa otro spec.
function oracle(text: string, explicitSecrets: readonly string[], max = 500): string {
  // Primero los más largos para no dejar sufijos de secretos solapados.
  for (const secret of [...explicitSecrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[REDACTED]@')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)(?:Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 500;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type Interval = { index: number; start: number; end: number; bearer: boolean; auth: boolean; open: string; close: string };
type Region = { primary: Interval; end: number; outputEnd: number };
type Model = { output: string; regions: Region[]; N: boolean; X: boolean; O: boolean; T: boolean; C: boolean };
const generic = '(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|private[_-]?key)';
const suffix = '(?:[_-]?(?:access[_-]?)?(?:key|hash))?';
const camel = '(?:Password|Passwd|Pwd|Passphrase|Secret|Token|ApiKey|PrivateKey)';

function referenceValue(text: string, start: number, auth: boolean): Pick<Interval, 'end' | 'open' | 'close'> | undefined {
  const rest = text.slice(start);
  const opening = /^(\\{0,3})(["'])/.exec(rest);
  if (opening) {
    const open = opening[0];
    let end = open.length, close = '';
    if (opening[1]) {
      const match = /\\{1,3}["']/.exec(rest.slice(end));
      if (!match) return { end: text.length, open, close };
      // Un tramo mayor de barras cierra con su última terna.
      end += match.index + match[0].length;
      close = match[0];
      end += /^[^\s,;]*/.exec(rest.slice(end))![0].length;
    } else {
      while (end < rest.length) {
        if (rest[end] === opening[2]) { close = rest[end++]; break; }
        end += rest[end] === '\\' ? 2 : 1;
      }
    }
    return { end: Math.min(text.length, start + end), open, close };
  }
  const value = auth ? /^[^\r\n]*/.exec(rest) : /^(?:Bearer\s+[^\s,;]+|[^\s,;]+)/i.exec(rest);
  return value ? { end: start + value[0].length, open: '', close: '' } : undefined;
}
function model(input: string): Model {
  // Siempre aplica URL; sin prefiltro, sin tablas, sin memoria de tokens.
  const text = input.replace(URL_RE, '$1[REDACTED]@');
  const intervals: Interval[] = [];
  const primary = new RegExp(`^(?:${generic}|authorization)`, 'i');
  const camelKey = new RegExp(`^(?:${camel}|Authorization)`);
  const suffixRE = new RegExp(`^${suffix}`, 'i');
  for (let index = 0; index < text.length; index++) {
    const rest = text.slice(index);
    const key = (index > 0 && /[A-Za-z0-9]/.test(text[index - 1]) ? camelKey : primary).exec(rest);
    if (key) {
      const auth = key[0].toLowerCase() === 'authorization';
      const end = index + key[0].length;
      const keyEnd = end + (auth ? 0 : suffixRE.exec(text.slice(end))![0].length);
      const tail = /^\\{0,3}["']?\s*[=:]\s*/.exec(text.slice(keyEnd));
      if (tail) {
        const start = keyEnd + tail[0].length, value = referenceValue(text, start, auth);
        if (value) intervals.push({ index, start, ...value, bearer: false, auth });
      }
    }
    if (index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1])) {
      const bearer = /^Bearer\s+[^\s,;]+/i.exec(rest);
      if (bearer) intervals.push({ index, start: index, end: index + bearer[0].length, bearer: true, auth: false, open: '', close: '' });
    }
  }
  const result: Model = { output: '', regions: [], N: false, X: false, O: false, T: false, C: false };
  for (const a of intervals) for (const b of intervals) if (a !== b) {
    const nested = b.index >= a.start && b.index < a.end;
    result.N ||= nested; result.X ||= nested && b.end > a.end;
    result.O ||= a.start < b.start && b.start < a.end && a.end < b.end;
    result.T ||= a.end === b.start; result.C ||= a.start === b.start;
  }
  intervals.sort((a, b) => a.start - b.start || Number(a.bearer) - Number(b.bearer));
  for (const interval of intervals) {
    const last = result.regions.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.regions.push({ primary: interval, end: interval.end, outputEnd: 0 });
  }
  let copied = 0;
  for (const region of result.regions) {
    const p = region.primary;
    result.output += text.slice(copied, p.start) + (p.bearer ? 'Bearer [REDACTED]' : p.open + '[REDACTED]' + (region.end === p.end ? p.close : ''));
    region.outputEnd = result.output.length; copied = region.end;
  }
  result.output += text.slice(copied);
  return result;
}
function minimize(input: string, fails: (value: string) => boolean): string {
  for (let size = Math.ceil(input.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let index = 0; index < input.length;) {
      const candidate = input.slice(0, index) + input.slice(index + size);
      if (fails(candidate)) { input = candidate; index = 0; } else index++;
    }
  }
  return input;
}
function same(input: string, actual: string, expected: string, property: string): void {
  if (actual !== expected) throw new Error(JSON.stringify({ property, input, actual, expected }));
}
function idempotenceClass(input: string, first: string, second: string): 'A' | 'B' | 'C' | undefined {
  let d = 0;
  while (d < Math.min(first.length, second.length) && first[d] === second[d]) d++;
  const ref = model(input);
  for (const r of ref.regions) {
    const p = r.primary;
    if (p.bearer || r.end <= p.end || d < r.outputEnd) continue;
    if (p.auth && /[\r\n]/.test(input.slice(p.end, r.end)) && /^[^\r\n]+/.test(input.slice(r.end)) && !/[\r\n]/.test(first.slice(r.outputEnd, d))) return 'A';
    if (!p.auth && p.close && r.end < input.length) return 'B';
  }
  if (first === oracle(input, [], Number.MAX_SAFE_INTEGER) && oracle(first, [], Number.MAX_SAFE_INTEGER) !== first && second === oracle(first, [], Number.MAX_SAFE_INTEGER)) return 'C';
  return undefined;
}
function boundedIdempotence(input: string, first: string, property: string): void {
  const second = clean(first);
  if (first.length > MAX_SCRUB_INPUT) same(input, second, CADENA_LARGA, property);
  else if (first !== second && !idempotenceClass(input, first, second)) throw new Error(JSON.stringify({ property, input, actual: second, expected: first }));
}
function invariants(input: string): void {
  const actual = clean(input), expected = model(input).output;
  if (actual !== expected) {
    const minimal = minimize(input, value => clean(value) !== model(value).output);
    same(minimal, clean(minimal), model(minimal).output, 'referencia');
  }
  boundedIdempotence(input, actual, 'idempotencia');
  if (input.includes('CANARIOX') && !oracle(input, [], Number.MAX_SAFE_INTEGER).includes('CANARIOX') && actual.includes('CANARIOX')) {
    throw new Error(JSON.stringify({ property: 'monotonía', input, actual, expected: 'CANARIOX ausente' }));
  }
}
type Row = { input: string; expected: string; ocultar: string[]; conservar: string[] };
const row = (input: string, expected: string, ocultar: string[] = ['ALFA7'], conservar: string[] = []): Row => ({ input, expected, ocultar, conservar });
const keys = ['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'privatekey', 'private_key', 'private-key'];
const endings = ['', 'key', 'hash', '_key', '-hash', 'accesskey', '_access_key', '-access-hash', '_access-key', '-access_hash'];
const rows: Row[] = keys.flatMap(key => endings.flatMap(ending => [key + ending, (key + ending).toUpperCase()].map(word => row(`${word}=ALFA7`, `${word}=[REDACTED]`))));
rows.push(...['HTTPToken', 'NewToken', 'accessToken', 'app.password', 'x-api-key', 'client-secret', 'access_token', 'DATABASE_PASSWORD', 'xPrivateKey', 'xAuthorization'].map(key => row(`${key}: ALFA7`, `${key}: [REDACTED]`)));
rows.push(...['tokenize=true', 'passwordless=true', 'token_type=Bearer', 'tokens: ALFA7', 'mytoken=ALFA7', '2token=ALFA7', 'Authorization header is missing', 'Basic configuration', '\\"abc', 'ſecret=ALFA7', 'apiKey=ALFA7', 'prıvatekey=ALFA7', 'prİvatekey=ALFA7'].map(input => row(input, input, [], [input])));
rows.push(
  row('{"password":"ALFA7"}', '{"password":"[REDACTED]"}'),
  row('{"authorization":"Basic ALFA7","x":1}', '{"authorization":"[REDACTED]","x":1}', ['ALFA7'], ['"x":1']),
  row('Authorization: Basic ALFA7', 'Authorization: [REDACTED]'),
  row('password="ALFA7', 'password="[REDACTED]'),
  row("password='ALFA7\\", "password='[REDACTED]"),
  row('password="ALFA7\\"', 'password="[REDACTED]'),
  row('authorization: Digest a="ALFA7', 'authorization: [REDACTED]'),
  row('{"password":"ALFA7', '{"password":"[REDACTED]'),
  row('password=\\', 'password=[REDACTED]', ['\\']),
  row('authorization:', 'authorization:[REDACTED]', []),
  row('password="', 'password="[REDACTED]', []),
  row('password token=ALFA7', 'password token=[REDACTED]'),
  row('password=ALFA7 BRAVO8', 'password=[REDACTED] BRAVO8', ['ALFA7'], ['BRAVO8']),
  row('password=ALFA7,BRAVO8', 'password=[REDACTED],BRAVO8', ['ALFA7'], ['BRAVO8']),
  row('password=ALFA7;BRAVO8', 'password=[REDACTED];BRAVO8', ['ALFA7'], ['BRAVO8']),
  row('token: Bearer ALFA7 BRAVO8', 'token: [REDACTED] BRAVO8', ['ALFA7'], ['BRAVO8']),
  row('token: "ALFA7 BRAVO8"', 'token: "[REDACTED]"', ['ALFA7', 'BRAVO8']),
  row('authorization: ALFA7 BRAVO8\nCHARLIE9', 'authorization: [REDACTED]\nCHARLIE9', ['ALFA7', 'BRAVO8'], ['CHARLIE9']),
);
for (let opening = 1; opening <= 3; opening++) for (let closing = 1; closing <= 5; closing++) {
  for (const quote of ['"', "'"]) for (const close of ['"', "'"]) {
    const a = '\\'.repeat(opening) + quote, b = '\\'.repeat(closing) + close;
    rows.push(row(`password=${a}ALFA7 BRAVO8${b}COLA9 RESTO0`, `password=${a}[REDACTED]${'\\'.repeat(Math.min(3, closing))}${close} RESTO0`, ['ALFA7', 'BRAVO8', 'COLA9'], ['RESTO0']));
  }
}
it.each(rows)('dirigido %# $input', ({ input, expected, ocultar, conservar }) => {
  same(input, clean(input), expected, 'tabla');
  for (const hidden of ocultar) expect(clean(input)).not.toContain(hidden);
  for (const visible of conservar) expect(clean(input)).toContain(visible);
  invariants(input);
});


const families: [string, (size: number) => string][] = [
  ['barras', size => 'password=\\"' + '\\'.repeat(size - 19) + 'CANARIOX'],
  ['escapadas', size => 'password="' + '\\"'.repeat(size).slice(0, size - 18) + 'CANARIOX'],
  ['sin cierre', size => 'password="' + 'x'.repeat(size - 18) + 'CANARIOX'],
  ['JSON un nivel', size => 'password=\\"' + '{\\"x\\":1}'.repeat(size).slice(0, size - 19) + 'CANARIOX'],
  ['JSON dos niveles', size => 'password="' + '{\\\\\\"x\\\\\\":1}'.repeat(size).slice(0, size - 18) + 'CANARIOX'],
  ['alternas', size => 'password="' + "'x".repeat(size).slice(0, size - 18) + 'CANARIOX'],
  ['espacios', size => 'password' + ' '.repeat(size - 17) + '=CANARIOX'],
  ['fallos con espacios', size => ('password '.repeat(size)).slice(0, size - 15) + ' token=CANARIOX'],
  ['saltos de línea', size => 'authorization:' + '\n'.repeat(size - 22) + 'CANARIOX'],
  ['identificador', size => 'x'.repeat(size - 16) + 'Token=CANARIOX  '],
  ['camel repetido', size => 'xToken '.repeat(size).slice(0, size - 15) + ' Token=CANARIOX'],
  ['sufijos', size => 'password_access_ '.repeat(size).slice(0, size - 15) + ' token=CANARIOX'],
];

it('C-2: documenta la pérdida del mensaje al crecer sobre el umbral de entrada', () => {
  // Propiedad heredada del umbral de entrada: falla cerrado; O-4 sigue pendiente.
  for (const size of [16380, 16381, 16382, 16383, 16384]) {
    for (const value of ['CANARIOX', 'CANARIOXYZ', 'CANARIO_SECRETO_LARGO']) {
      const prefix = 'password' + ' '.repeat(size - 9 - value.length) + '=';
      const input = prefix + value;
      const first = clean(input), second = clean(first);
      const firstLength = size + 10 - value.length;
      expect(input.length).toBe(size);
      expect(first).toBe(prefix + '[REDACTED]');
      expect(first.length).toBe(firstLength);
      expect(second.length).toBe(firstLength > MAX_SCRUB_INPUT ? CADENA_LARGA.length : firstLength);
      expect(second).toBe(firstLength > MAX_SCRUB_INPUT ? CADENA_LARGA : first);
      expect(first).not.toContain(value);
      expect(second).not.toContain(value);
    }
  }
});

function enumerate(fragments: string[], depth: number, visit: (input: string) => void): number {
  let count = 0;
  for (let size = 0; size <= depth; size++) for (let code = 0; code < fragments.length ** size; code++) {
    let input = '', digits = code, marker = 0;
    for (let i = 0; i < size; i++) {
      const part = fragments[digits % fragments.length]; digits = Math.floor(digits / fragments.length);
      input += part === '#' ? 'Q' + String.fromCharCode(97 + Math.floor(marker / 26), 97 + marker++ % 26) : part;
    }
    visit(input); count++;
  }
  return count;
}
function randomInputs(fragments: string[], count: number, depth: number, seed: number, visit: (input: string) => void, maxLength = Infinity): void {
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let accepted = 0; accepted < count;) {
    let input = '', marker = 0;
    const size = 1 + Math.floor(next() * depth);
    for (let i = 0; i < size; i++) {
      const part = fragments[Math.floor(next() * fragments.length)];
      input += part === '#' ? 'Q' + String.fromCharCode(97 + Math.floor(marker / 26), 97 + marker++ % 26) : part;
    }
    if (input.length > maxLength) continue;
    visit(input); accepted++;
  }
}
const FULL = ['password', 'token', 'secret', 'pwd', 'api_key', 'authorization', 'access_', 'ApiKey', 'Token', 'Bearer', 'bearer', '=', ':', ' ', '\n', ',', ';', '"', "'", '\\', '\\"', '/', '_', '#', '-', '.', '}', '{'];
const restricted = (input: string) => !/authorization|['"\\]|_(?:password|passwd|pwd|secret|token|api[_-]?key)|[A-Za-z0-9](?:Password|Passwd|Pwd|Passphrase|Secret|Token|ApiKey|PrivateKey|Authorization)|passphrase|private[_-]?key|(?:password|passwd|pwd|secret|token|api[_-]?key)[_-]?(?:access[_-]?)?(?:key|hash)/i.test(input);
function corpusChecks() {
  const counts = { total: 0, monotonicity: 0, exact: 0, excess: 0, A: 0, B: 0, C: 0, urlSkip: 0 };
  const check = (input: string) => {
    counts.total++;
    const first = clean(input), old = oracle(input, [], Number.MAX_SAFE_INTEGER);
    const leaked = (value: string) => {
      const before = oracle(value, [], Number.MAX_SAFE_INTEGER), after = clean(value);
      return (value.match(/Q[a-z]{2}/g) ?? []).some(marker => !before.includes(marker) && after.includes(marker));
    };
    if (leaked(input)) {
      const minimal = minimize(input, leaked);
      throw new Error(JSON.stringify({ property: 'monotonía', input: minimal, actual: clean(minimal), expected: oracle(minimal, [], Number.MAX_SAFE_INTEGER) }));
    }
    counts.monotonicity++;
    if (!input.includes('://')) {
      same(input, input.replace(URL_RE, '$1[REDACTED]@'), input, 'salto URL'); counts.urlSkip++;
    }
    if (restricted(input)) {
      if (first !== old) {
        if (!model(input).X) {
          const minimal = minimize(input, value => restricted(value) && clean(value) !== oracle(value, [], Number.MAX_SAFE_INTEGER) && !model(value).X);
          same(minimal, clean(minimal), oracle(minimal, [], Number.MAX_SAFE_INTEGER), 'igualdad sin X');
        }
        counts.excess++;
      } else counts.exact++;
    }
    const second = clean(first);
    if (first !== second) {
      const kind = idempotenceClass(input, first, second);
      if (!kind) {
        const minimal = minimize(input, value => clean(value) !== clean(clean(value)) && !idempotenceClass(value, clean(value), clean(clean(value))));
        throw new Error(JSON.stringify({ property: 'idempotencia sin A/B/C', input: minimal, actual: clean(clean(minimal)), expected: clean(minimal) }));
      }
      counts[kind]++;
    }
  };
  return { counts, check };
}
it('referencia independiente: exhaustivo y aleatorio hasta 64 caracteres', () => {
  const fragments = ['password', 'token', 'authorization', 'ApiKey', '_', 'x', '=', ':', ' ', '\n', '"', "'", '\\', '\\"', 'CANARIOX', 'Bearer ', ',', ';', 'hash', 'passphrase'];
  const exhaustive = enumerate(fragments, 4, invariants);
  randomInputs(fragments, 100000, 8, 0x5c12ab34, invariants, 64);
  console.info({ referenceExhaustive: exhaustive, referenceRandom: 100000 });
}, 900000);
// Superconjunto de las profundidades máximas: incluye 0–máximo en cada familia.
// 335923 + 960800 + 3 × 137257 + 150000 aleatorias = 1.858.494 entradas.
it('corpus rápido F1–F5 y 150 000 aleatorias', () => {
  const { counts, check } = corpusChecks();
  for (const [fragments, depth] of [
    [['token', '\\', '=', ' ', '#', ':'], 7],
    [['token', '\\', ':', '=', 'Bearer', ' ', '#'], 7],
    [['password', '"', '=', ' ', '#', '}', '\\"'], 6],
    [['authorization', '=', ':', ' ', '\n', '#', 'Bearer'], 6],
    [['Token', '_', 'key', '=', ' ', '#', 'access_'], 6],
  ] as [string[], number][]) console.info({ fragments, count: enumerate(fragments, depth, check) });
  randomInputs(FULL, 150000, 12, 0x5c12ab34, check);
  console.info({ fast: counts });
}, 900000);
(process.env.DEEP === '1' ? it : it.skip)('corpus profundo C/A/N1–N4/R/R2/X', () => {
  const { counts, check } = corpusChecks();
  for (const [name, fragments, depth] of [
    ['C', ['token', '=', ' ', 'Bearer', '#', '-', ',', '\\', ':'], 7],
    ['A', ['password', 'token', '=', ':', ' ', 'Bearer', '#', '"', '\\', ',', '\n', '-'], 6],
    ['N1', ['access_token', 'token', 'password', '=', ':', ' ', '#', '-', '\\'], 7],
    ['N2', ['password', 'token', '=', ':', ' ', '"', "'", '\\"', '#', '}{', ','], 6],
    ['N3', ['authorization', 'token', '=', ':', ' ', '\n', '#', '"', 'Bearer', '-'], 6],
    ['N4', ['Token', 'ApiKey', 'secret', '_key', '_', 'hash', '=', ':', ' ', '#', '-'], 6],
    ['R', ['password', '=', ':', ' ', 'Bearer', '#', '-', ',', '/'], 7],
  ] as [string, string[], number][]) console.info({ name, count: enumerate(fragments, depth, check) });
  randomInputs(['password', 'token', 'secret', 'pwd', 'api_key', 'Bearer', 'bearer', '=', ':', ' ', '\n', ',', ';', '/', '#', '-', '.', 'abcXYZ', '0123456789', '@', '://', '+'], 400000, 12, 0xabcdef12, check);
  randomInputs(FULL, 600000, 12, 0x5c12ab34, check);
  console.info({ deep: counts });
}, 900000);

it('O1: cola inválida conserva el texto', () => {
  // La comilla debe preceder a los espacios; un espacio antes de ella invalida la cola.
  expect(clean('pwd "=V')).toBe('pwd "=V');
});

it('O1: todas las mayúsculas, sufijos y colas; camel con prefijo x', () => {
  const endings = ['', ...['', '_', '-'].flatMap(a => ['', 'access', 'access_', 'access-'].flatMap(b => ['key', 'hash'].map(c => a + b + c)))];
  let count = 0;
  const check = (word: string, auth: boolean) => {
    for (const suffix of auth ? [''] : endings) for (const tail of ['=', ' = ', '\\:', '" =']) {
      const prefix = word + suffix + tail;
      same(prefix + 'VALOR', clean(prefix + 'VALOR'), prefix + '[REDACTED]', 'O1'); count++;
    }
  };
  for (const key of [...keys, 'authorization']) {
    const positions = [...key].map((char, i) => /[a-z]/.test(char) ? i : -1).filter(i => i >= 0);
    for (let mask = 0; mask < 2 ** positions.length; mask++) {
      const chars = [...key];
      for (let k = 0; k < positions.length; k++) if (mask & (1 << k)) chars[positions[k]] = chars[positions[k]].toUpperCase();
      check(chars.join(''), key === 'authorization');
    }
  }
  for (const key of ['Password', 'Passwd', 'Pwd', 'Passphrase', 'PrivateKey', 'Secret', 'Token', 'ApiKey', 'Authorization']) check('x' + key, key === 'Authorization');
  console.info({ orderCases: count });
}, 900000);

it.each([
  ['password' + ' '.repeat(5000) + '= a token' + ' '.repeat(5000) + ': b', 'password' + ' '.repeat(5000) + '= [REDACTED] token' + ' '.repeat(5000) + ': [REDACTED]'],
  ['access_token=password' + ' '.repeat(4000) + ':' + ' '.repeat(4000) + 'Qaa', 'access_token=[REDACTED]' + ' '.repeat(4000) + ':' + ' '.repeat(4000) + '[REDACTED]'],
  [('token' + ' '.repeat(3000) + '=x ').repeat(3), ('token' + ' '.repeat(3000) + '=[REDACTED] ').repeat(3)],
  ['password' + ' '.repeat(3000) + '=' + ' '.repeat(3000) + 'Bearer x', 'password' + ' '.repeat(3000) + '=' + ' '.repeat(3000) + '[REDACTED]'],
  ['token' + ' '.repeat(2500) + ': Bearer a' + ' '.repeat(2500) + 'password=b', 'token' + ' '.repeat(2500) + ': [REDACTED]' + ' '.repeat(2500) + 'password=[REDACTED]'],
  ['password' + ' '.repeat(6000) + ' token=Z', 'password' + ' '.repeat(6000) + ' token=[REDACTED]'],
  ['token\n\n\n\t\t:\n\n\tpassword\t\t=\t\tQaa', 'token\n\n\n\t\t:\n\n\t[REDACTED]\t\t=\t\t[REDACTED]'],
  ['authorization' + ' '.repeat(4000) + ':' + ' '.repeat(4000) + 'Basic x\ntoken=y', 'authorization' + ' '.repeat(4000) + ':' + ' '.repeat(4000) + '[REDACTED]\ntoken=[REDACTED]'],
])('D1–D8 orden dirigido %#', (input, expected) => same(input, clean(input), expected, 'orden'));

const history: Row[] = [
  row('pwd\\:=Bearer X', 'pwd\\:[REDACTED]', ['X']),
  row('Bearer ApiKey:\nCANARIOX', 'Bearer [REDACTED]\n[REDACTED]', ['CANARIOX']),
  row('Bearer password: abc', 'Bearer [REDACTED] [REDACTED]', ['abc']),
  row('password="a Bearer x"', 'password="[REDACTED]"', ['Bearer', ' x']),
  row('{"authorization":"Bearer x","y":1}', '{"authorization":"[REDACTED]","y":1}', ['Bearer'], ['"y":1']),
  row('secret:/Bearer a', 'secret:[REDACTED]', ['/Bearer']),
  row('token:=Bearer Bearer X', 'token:[REDACTED]', ['X']),
  row('pwd\\:=Bearer Bearer X', 'pwd\\:[REDACTED]', ['X']),
  row('access_token=-Bearer X', 'access_token=[REDACTED]', ['X']),
  row('password="a Bearer x"\ntoken=y\nauthorization: Basic z', 'password="[REDACTED]"\ntoken=[REDACTED]\nauthorization: [REDACTED]', ['Basic', 'Bearer']),
  row('token\\=token =Qaa', 'token\\=[REDACTED] =[REDACTED]', ['Qaa']),
  row('token\\:token: Qaa', 'token\\:[REDACTED] [REDACTED]', ['Qaa']),
  ...['access_token=password:', 'secret_key=password:', 'tokenKey=password:', 'access_token=-password:'].map(prefix => row(prefix + ' Qaa', prefix.slice(0, prefix.indexOf('=') + 1) + '[REDACTED] [REDACTED]', ['Qaa'])),
  row('access_token=password : Qaa', 'access_token=[REDACTED] : [REDACTED]', ['Qaa'], [' : ']),
  row('access_token=token =Qaa', 'access_token=[REDACTED] =[REDACTED]', ['Qaa']),
  row('password=abc def', 'password=[REDACTED] def', ['abc'], [' def']),
  row('password=abc,def', 'password=[REDACTED],def', ['abc'], [',def']),
  row('password="abc def"', 'password="[REDACTED]"', ['abc', 'def']),
  row('{"password":"abc"}', '{"password":"[REDACTED]"}', ['abc']),
  row('Authorization: Basic dXNlcjpwYXNz', 'Authorization: [REDACTED]', ['Basic', 'dXNlcjpwYXNz']),
  row('{"authorization":"Basic abc","y":1}', '{"authorization":"[REDACTED]","y":1}', ['abc'], ['"y":1']),
  row('password=\\"abc def\\"', 'password=\\"[REDACTED]\\"', ['abc', 'def']),
  row('password=\\"abc\\"def ghi', 'password=\\"[REDACTED]\\" ghi', ['abc', 'def'], ['ghi']),
  row('password="abc def', 'password="[REDACTED]', ['abc', 'def']),
  row("password='abc\\", "password='[REDACTED]", ['abc']),
  row('authorization: Digest a="1', 'authorization: [REDACTED]', ['Digest']),
  row('password=', 'password=', [], ['password=']),
  row('password="', 'password="[REDACTED]', []),
  row('authorization:', 'authorization:[REDACTED]', []),
  row('password token=CANARIO', 'password token=[REDACTED]', ['CANARIO']),
  row('password"token=CANARIO', 'password"token=[REDACTED]', ['CANARIO']),
  ...['access_token', 'accessToken', 'DATABASE_PASSWORD', 'client-secret'].map(key => row(key + '=abc', key + '=[REDACTED]', ['abc'])),
  row('x-api-key: abc', 'x-api-key: [REDACTED]', ['abc']),
  row('token: Bearer abc def', 'token: [REDACTED] def', ['abc'], [' def']),
  row('authorization: Bearer CANARIO_AUTH', 'authorization: [REDACTED]', ['CANARIO_AUTH']),
  row('Bearer X', 'Bearer [REDACTED]', ['X']),
  row('password=a Bearer x token=y authorization: Basic z', 'password=[REDACTED] Bearer [REDACTED] token=[REDACTED] authorization: [REDACTED]', ['Basic']),
  row('postgres://user:CANARIO_CLAVE@localhost/db', 'postgres://[REDACTED]@localhost/db', ['CANARIO_CLAVE'], ['@localhost/db']),
  ...['tokenize=true', 'passwordless=true', 'token_type=Bearer', 'mytoken=abc', 'Authorization header is missing', 'Basic configuration', 'tokens: 5', 'https://example.test/path?x=1'].map(input => row(input, input, [], [input])),
  // B.3: P1 NO garantiza JSON válido. O-1 queda expresamente fuera de alcance.
  row('{"msg":"password=abc"}', '{"msg":"password=[REDACTED]', ['abc']),
  row('{"msg":"login password=abc ok"}', '{"msg":"login password=[REDACTED] ok"}', ['abc'], [' ok"}']),
  row('{"password":"x token=y"}', '{"password":"[REDACTED]', ['token=y']),
  row('{ "authorization": 107 }', '{ "authorization": [REDACTED]', ['107']),
  row('["password= token=abc"]', '["password= [REDACTED]', ['abc']),
  row('{"data":"api_key=\\"abc\\""}', '{"data":"api_key=\\"[REDACTED]\\"', ['abc']),
];
it.each(history)('B: salida/ocultar/conservar %#', ({ input, expected, ocultar, conservar }) => {
  const actual = clean(input);
  same(input, actual, expected, 'B');
  for (const text of ocultar) expect(actual).not.toContain(text);
  for (const text of conservar) expect(actual).toContain(text);
  invariants(input);
});
it.each([
  ['A', 'authorization=Bearer\nauthorization ', 'authorization=[REDACTED] ', 'authorization=[REDACTED]'],
  ['A', 'authorization:Bearer\ntoken ', 'authorization:[REDACTED] ', 'authorization:[REDACTED]'],
  ['A', 'authorization=Bearer\n\nQaa;-":token', 'authorization=[REDACTED];-":token', 'authorization=[REDACTED]'],
  ['B', '/password="Bearer \\secretApiKey"/\n', '/password="[REDACTED]\n', '/password="[REDACTED]'],
  ['C', ',=+abcXYZ+://-api_key://;password@', ',=+abcXYZ+://-api_key:[REDACTED];password@', ',=+abcXYZ+://[REDACTED]@'],
  ['C', 'abcXYZQaa0123456789://pwd://@abcXYZ,Qabapi_key@', 'abcXYZQaa0123456789://pwd:[REDACTED],Qabapi_key@', 'abcXYZQaa0123456789://[REDACTED]@'],
])('C: idempotencia residual %s %#', (kind, input, first, second) => {
  same(input, clean(input), first, 'C primera');
  same(first, clean(first), second, 'C segunda');
  expect(idempotenceClass(input, first, second)).toBe(kind);
  invariants(input);
});
it.each([
  ['authorization=Bearer authorization ', 'authorization=[REDACTED]'],
  ['authorization=Bearer\nauthorization', 'authorization=[REDACTED]'],
  ['authorization=Bearer\nx\n', 'authorization=[REDACTED]\n'],
  ['/password="Bearer \\secretApiKey" /\n', '/password="[REDACTED]" /\n'],
  ['/password="Bearer \\secretApiKey"\n', '/password="[REDACTED]"\n'],
  ['/password="Bearer \\secretApiKey"/', '/password="[REDACTED]'],
])('controles negativos de A/B %#', (input, expected) => {
  same(input, clean(input), expected, 'negativo primera');
  same(input, clean(expected), expected, 'negativo idempotente');
  invariants(input);
});

function minimumTime(action: () => void): number {
  for (let i = 0; i < 20; i++) action();
  let minimum = Infinity;
  for (let trial = 0; trial < 7; trial++) {
    const start = performance.now();
    for (let i = 0; i < 100; i++) action();
    minimum = Math.min(minimum, (performance.now() - start) / 100);
  }
  return minimum;
}
const repeated = (fragment: string) => (size: number) => fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size - 15) + ' token=CANARIOX';
// Conserva los generadores previos de tamaños exactos; añade las 17 familias S4.
const s4Families: [string, (size: number) => string][] = [
  ['password=password', repeated('password=')],
  ['authorization:authorization', repeated('authorization:')],
  ['password=" repetido', repeated('password="')],
  ['comillas alternadas', repeated('password="password=\'')],
  ['password=\\" repetido', repeated('password=\\"')],
  ['comilla y barras', size => 'password="' + '\\'.repeat(size - 18) + 'CANARIOX'],
  ['comilla y comillas escapadas', size => 'password="' + '\\"'.repeat(size).slice(0, size - 18) + 'CANARIOX'],
  ['apertura escapada y barras', size => 'password=\\"' + '\\'.repeat(size - 19) + 'CANARIOX'],
  ['token=Bearer', repeated('token=Bearer ')], ['Bearer', repeated('Bearer ')],
  ['a_token=-', repeated('a_token=-')], ['tokenKey=password:', repeated('tokenKey=password:')],
  ['JSON anidado', repeated('{"password":"{\\"password\\":\\"x\\"}"}')],
  ['cola de espacios', size => 'password' + ' '.repeat(size - 18) + '= CANARIOX'],
  ['authorization con salto', repeated('authorization:\n')],
  ['letras pstab', size => 'pstab'.repeat(size).slice(0, size - 16) + '= token=CANARIOX'],
  ['bearer minúscula', repeated('bearer ')],
];
it.each([...families, ...s4Families])('G1–G4: %s', (name, generate) => {
  const times: number[] = [];
  for (const size of [2048, 4096, 8192, 16384]) {
    const input = generate(size);
    expect(input.length).toBe(size);
    const actual = clean(input);
    expect(actual).not.toContain('CANARIOX');
    expect(actual).not.toBe(CADENA_LARGA);
    boundedIdempotence(input, actual, 'frontera');
    times.push(minimumTime(() => { clean(input); }));
  }
  const ratio = times[3] / times[0];
  console.info({ family: name, milliseconds: times, ratio });
  expect(times[3]).toBeLessThanOrEqual(5);
  expect(ratio).toBeLessThanOrEqual(16);
  const budget = new RecordBudget(), remaining = budget.remaining;
  expect(scrubText(generate(MAX_SCRUB_INPUT) + 'x', 1000000, budget)).toBe(CADENA_LARGA);
  expect(budget.remaining).toBe(remaining);
});
it('informa coste por llamada y conserva exportaciones', () => {
  for (const input of ['registro normal breve', 'registro: normal breve', 'password=CANARIOX']) console.info({ input, microsecondsPerCall: minimumTime(() => { clean(input); }) * 1000 });
  expect(Object.keys(registry).sort()).toEqual(['MAX_SCRUB_INPUT', 'CADENA_LARGA', 'LIMITE_PRESUPUESTO', 'RECORD_BUDGET_CHARS', 'RecordBudget', 'registerSecret', 'scrubText', 'activeSecretCount', 'resetSecretsForTests'].sort());
});
