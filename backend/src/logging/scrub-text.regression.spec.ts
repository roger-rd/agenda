import { registerSecret, scrubText, resetSecretsForTests, MAX_SCRUB_INPUT, CADENA_LARGA, LIMITE_PRESUPUESTO, RECORD_BUDGET_CHARS, RecordBudget } from './secret-registry';

afterEach(resetSecretsForTests);

// Oráculo literal de HEAD, con secretos explícitos en lugar del mapa privado.
function oracle(text: string, explicitSecrets: readonly string[], max = 500): string {
  // Primero los más largos para no dejar sufijos de secretos solapados.
  for (const secret of [...explicitSecrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[REDACTED]@')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)(?:Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 500;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const knownCases: [string, string][] = [
  ['postgres://user:CANARIO_CLAVE@localhost/db', 'postgres://[REDACTED]@localhost/db'],
  ['password="CANARIO_CLAVE"', 'password=[REDACTED]'],
  ["token: 'CANARIO_TOKEN'", 'token: [REDACTED]'],
  ['Bearer CANARIO_TOKEN', 'Bearer [REDACTED]'],
  ['api-key=CANARIO_KEY', 'api-key=[REDACTED]'],
  ['authorization: Bearer CANARIO_AUTH', 'authorization: [REDACTED]'],
];
it.each(knownCases)('verifica el oráculo y la implementación: %s', (input, expected) => {
  expect(oracle(input, [])).toBe(expected);
  expect(scrubText(input)).toBe(expected);
});
it('verifica el oráculo con secreto y truncado conocidos', () => {
  const secret = 'fake-password-for-unit-tests-0001';
  registerSecret(secret);
  expect(oracle(secret + 'abcdef', [secret], 12)).toBe('[REDACTED]ab…');
  expect(scrubText(secret + 'abcdef', 12)).toBe('[REDACTED]ab…');
});

const seed = Number(process.env.SCRUB_SEED ?? 0x5c12ab34) >>> 0;
const explicitSecrets = ['FICTICIO_123', 'FICTICIO_1234', 'FICTICIO_1234_solapado', 'S'.repeat(256), 'clave_😀_ficticia'];
const maxima = [0, 12, 80, 300, 500, 4000, 8192];

function randomGenerator(initial: number): () => number {
  let state = initial;
  return () => {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

// Reduce por eliminación hasta que ningún carácter se pueda quitar conservando el fallo.
function minimalMismatch(input: string, max: number): string {
  const differs = (text: string) => scrubText(text, max) !== oracle(text, explicitSecrets, max);
  for (let size = Math.ceil(input.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let index = 0; index < input.length;) {
      const candidate = input.slice(0, index) + input.slice(index + size);
      if (differs(candidate)) { input = candidate; index = 0; }
      else index += 1;
    }
  }
  return input;
}

it('coincide con el oráculo en 20 000 cortos, 500 medianos, 20 largos y la frontera', () => {
  explicitSecrets.forEach(registerSecret);
  const random = randomGenerator(seed);
  const fragments = ['abcXYZ', '0123456789', '+', '.', '-', ':', '/', '@', ' ', '\n', "'", '"', '://', 'password', 'token', 'api_key', 'secret', 'Bearer', 'authorization', 'ñ', 'e\u0301', '😀', 'ſ', '\u212a', ...explicitSecrets];
  const generate = (length: number) => {
    let text = '';
    while (text.length < length) text += fragments[Math.floor(random() * fragments.length)];
    return text.slice(0, length);
  };
  const inputs: string[] = [];
  for (let i = 0; i < 20000; i++) inputs.push(generate(Math.floor(random() * 301)));
  for (let i = 0; i < 500; i++) inputs.push(generate(300 + Math.floor(random() * 3701)));
  for (let i = 0; i < 20; i++) {
    const length = 4000 + Math.floor(random() * 12385);
    inputs.push(i < 5 ? ['x', 'abc012', 'a.b-c+', '012345', '+.-abc'][i].repeat(length).slice(0, length) : generate(length));
  }
  inputs.push(generate(MAX_SCRUB_INPUT));
  inputs.forEach((input, index) => {
    const max = maxima[index % maxima.length];
    if (scrubText(input, max) !== oracle(input, explicitSecrets, max)) {
      const minimal = minimalMismatch(input, max);
      throw new Error(JSON.stringify({ seed, index, max, input: minimal, actual: scrubText(minimal, max), expected: oracle(minimal, explicitSecrets, max) }));
    }
  });
  expect(scrubText('x'.repeat(MAX_SCRUB_INPUT + 1))).toBe(CADENA_LARGA);
  console.info(`Diferencial: semilla=${seed}, cortos=20000, medianos=500, largos=20, frontera=1`);
});

it.each([
  ['1abc://u:p@h', '1abc://[REDACTED]@h'],
  ['123://u:p@h', '123://u:p@h'],
  ['+.1-Ab.C+://u:p@h', '+.1-Ab.C+://[REDACTED]@h'],
  ['HTTP://u:p@h ftp://a:b@h', 'HTTP://[REDACTED]@h ftp://[REDACTED]@h'],
  ['a://u:p@b://c:d@h', 'a://[REDACTED]@b://[REDACTED]@h'],
  ['a://b://c:d@h', 'a://b://[REDACTED]@h'],
  ['abc://user:', 'abc://user:'],
  ['abc://user:p:a:ss', 'abc://user:p:a:ss'],
  ['abc://user:p:a:ss@h', 'abc://[REDACTED]@h'],
])('esquema dirigido %s', (input, expected) => {
  expect(oracle(input, [])).toBe(expected);
  expect(scrubText(input)).toBe(expected);
});

it.each([0, 12, 500, 100000])('descarta cadenas largas sin datos ni consumo, max=%i', max => {
  const canary = 'CANARIO_NO_PUBLICAR';
  registerSecret(canary);
  const inputs = [canary + 'x'.repeat(16385), 'x'.repeat(8193) + canary + 'x'.repeat(8193), 'x'.repeat(16385) + canary, canary.repeat(1000)];
  for (const input of inputs) {
    const budget = new RecordBudget();
    expect(scrubText(input, max)).toBe('[CADENA_LARGA]');
    expect(scrubText(input, max, budget)).toBe('[CADENA_LARGA]');
    expect(budget.remaining).toBe(RECORD_BUDGET_CHARS);
    expect(budget.exhausted).toBe(false);
  }
});

it.each([NaN, -1, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rechaza presupuesto inválido %s', limit => {
  expect(() => new RecordBudget(limit)).toThrow(RangeError);
});
it('consume exactamente y mantiene agotamiento incluso con cero', () => {
  const budget = new RecordBudget(3);
  expect(budget.consume(0)).toBe(true);
  expect(budget.consume(1)).toBe(true);
  expect(budget.remaining).toBe(2);
  expect(budget.consume(2)).toBe(true);
  expect(budget.exhausted).toBe(true);
  expect(budget.consume(0)).toBe(false);
  expect(scrubText('', 500, budget)).toBe('[LIMITE]');
  expect(new RecordBudget(0).consume(0)).toBe(false);
});
it.each([4, NaN, -1, Infinity])('agota permanentemente sin consumir ante %s', chars => {
  const budget = new RecordBudget(3);
  expect(budget.consume(chars)).toBe(false);
  expect(budget.remaining).toBe(3);
  expect(budget.exhausted).toBe(true);
  expect(budget.consume(1)).toBe(false);
  expect(budget.consume(0)).toBe(false);
  expect(scrubText('', 0, budget)).toBe(LIMITE_PRESUPUESTO);
});
it('mantiene estado privado, marca auténtica y aislamiento', () => {
  const a = new RecordBudget(1), b = new RecordBudget(10);
  expect(Object.keys(a)).toEqual([]);
  expect(JSON.stringify(a)).toBe('{}');
  expect(RecordBudget.is(a)).toBe(true);
  for (const fake of [{}, Object.create(RecordBudget.prototype) as unknown, 42, null, undefined]) {
    expect(RecordBudget.is(fake)).toBe(false);
    expect(scrubText('normal', 500, fake as RecordBudget)).toBe('normal');
  }
  expect(scrubText('normal', 500, a)).toBe(LIMITE_PRESUPUESTO);
  expect(scrubText('normal', 500, b)).toBe('normal');
  expect(b.remaining).toBe(4);
  expect(scrubText('normal')).toBe('normal');
});
it('comprueba límites antes de split y replace, y los usa en el camino normal', () => {
  registerSecret('FICTICIO_1234');
  const budget = new RecordBudget(1);
  budget.consume(2);
  const split = jest.spyOn(String.prototype, 'split');
  const replace = jest.spyOn(String.prototype, 'replace');
  try {
    const large = scrubText('x'.repeat(16385), 0, budget);
    const exhausted = scrubText('x'.repeat(16384), 0, budget);
    const calls = [split.mock.calls.length, replace.mock.calls.length];
    expect(large).toBe(CADENA_LARGA);
    expect(exhausted).toBe(LIMITE_PRESUPUESTO);
    expect(calls).toEqual([0, 0]);
    split.mockClear(); replace.mockClear();
    const normal = scrubText('FICTICIO_1234', 500, new RecordBudget('FICTICIO_1234'.length));
    const normalCalls = [split.mock.calls.length, replace.mock.calls.length];
    expect(normal).toBe('[REDACTED]');
    expect(normalCalls[0]).toBeGreaterThan(0);
    expect(normalCalls[1]).toBeGreaterThan(0);
  } finally { split.mockRestore(); replace.mockRestore(); }
});

function minimumTime(action: () => void, repetitions = 7): number {
  action(); action();
  let minimum = Infinity;
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    action();
    minimum = Math.min(minimum, performance.now() - start);
  }
  return minimum;
}
it('descarta 32 MiB en tiempo constante', () => {
  const input = 'x'.repeat(32 * 1024 * 1024);
  let result = '';
  const ms = minimumTime(() => { result = scrubText(input); });
  expect(result).toBe('[CADENA_LARGA]');
  console.info(`32 MiB: ${ms.toFixed(6)} ms`);
  expect(ms).toBeLessThanOrEqual(25);
});
it.each([
  ['racha x', 'x'], ['hexadecimal', 'a0123456789abcdef'], ['base64 sin barra', 'Abc012+DEFxyz'],
  ['puntos', 'a.b.c'], ['dígitos', '1234567890'], ['espacios', 'texto con espacios '],
  ['JSON compacto', '{"a":123,"b":"dato"}'], ['separadores', '://'],
  ['palabra clave', 'password' + ' '.repeat(1000)],
  ['comillas abiertas', 'password="' + 'x'.repeat(16384)],
  ['Bearer espacios', 'Bearer' + ' '.repeat(16384)],
])('rendimiento a 16 KiB: %s', (name, fragment) => {
  const input = fragment.repeat(Math.ceil(16384 / fragment.length)).slice(0, 16384);
  const ms = minimumTime(() => { scrubText(input); });
  console.info(`${name}: ${ms.toFixed(6)} ms`);
  expect(ms).toBeLessThanOrEqual(25);
});
it('escala como máximo 40 veces entre 1 y 16 KiB', () => {
  const measure = (length: number) => {
    const input = 'x'.repeat(length);
    // Lotes de al menos 10 ms evitan dividir por una lectura cercana a cero.
    let iterations = 100;
    while (true) {
      const ms = minimumTime(() => { for (let i = 0; i < iterations; i++) scrubText(input); });
      if (ms >= 10) return ms / iterations;
      iterations *= 2;
    }
  };
  const small = measure(1024), large = measure(16384);
  console.info(`Escalado: 1 KiB=${small.toFixed(6)} ms, 16 KiB=${large.toFixed(6)} ms, razón=${large / small}`);
  expect(large / small).toBeLessThanOrEqual(40);
});
it('conserva Unicode, corte de sustitutos y secretos no BMP', () => {
  const secret = 'clave_😀_ficticia';
  registerSecret(secret);
  expect(scrubText('😀', 1)).toBe('\ud83d…');
  expect(scrubText('😀', 1)).toBe(oracle('😀', [secret], 1));
  expect(scrubText(secret + '😀', 11)).toBe(oracle(secret + '😀', [secret], 11));
  expect(scrubText(secret)).toBe('[REDACTED]');
});
it('conserva llamadas sin presupuesto y max por defecto', () => {
  const text = 'z '.repeat(300);
  expect(scrubText(text)).toBe(oracle(text, []));
  expect(scrubText(text)).toBe(text.slice(0, 500) + '…');
  for (const max of [...maxima, NaN, Infinity, -1, 12.9]) expect(scrubText(text, max)).toBe(oracle(text, [], max));
});
