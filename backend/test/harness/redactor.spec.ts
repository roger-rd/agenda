import { performance } from 'node:perf_hooks';
import { Redactor, createMatcher } from '../../scripts/harness/redactor.cjs';
import { secretVariants } from '../../scripts/harness/secret-variants.cjs';
import { encodings, random, secretsCorpus } from './support/redaction-corpus';
import { checkIsolatedMemory } from './support/memory-check';

function redact(secrets: string[], chunks: Uint8Array[]) {
  const filter = new Redactor(secrets);
  return Buffer.concat([...chunks.map(chunk => filter.push(chunk)), filter.finish()]);
}

describe('Redactor por bytes', () => {
  it('mantiene invariancia y ausencia de variantes en 1200 casos reproducibles', () => {
    const next = random(0x5142);
    for (const secret of secretsCorpus(1200)) {
      const encoded = encodings(secret);
      const source = Buffer.from('::' + encoded[next(encoded.length)] + '|normal!');
      const p = next(source.length + 1); const q = p + next(source.length - p + 1);
      const whole = redact([secret], [source]);
      expect(redact([secret], [source.subarray(0, p), source.subarray(p)])).toEqual(whole);
      expect(redact([secret], [source.subarray(0, p), source.subarray(p, q), source.subarray(q)])).toEqual(whole);
      expect(redact([secret], Array.from(source, byte => Buffer.from([byte])))).toEqual(whole);
      for (const variant of secretVariants(secret)) expect(whole.includes(variant)).toBe(false);
      expect(whole.includes(Buffer.from('[REDACTED]'))).toBe(true);
    }
  });
  it('fusiona coincidencias contiguas y solapadas', () => {
    expect(redact(['abcdefgh', 'efghijkl'], [Buffer.from('!abcdefghijklabcdefgh!')]).toString()).toBe('![REDACTED]!');
    expect(redact(['abcdefgh'], [Buffer.from('abcdefghabcdefgh')]).toString()).toBe('[REDACTED]');
  });
  it('preserva exactamente texto inocuo y prefijos que posteriormente se rompen', () => {
    const text = 'texto normal: S, SY, SYN-; fin!';
    expect(redact(['SYN-Secret123'], [Buffer.from(text)]).toString()).toBe(text);
  });
  it('suprime prefijos pendientes y coincidencias abiertas al finalizar', () => {
    for (const tail of ['S', 'SY', 'SYN-', 'SYN-Secret123']) {
      expect(redact(['SYN-Secret123'], [Buffer.from('texto!' + tail)]).toString()).toBe('texto![REDACTED]');
    }
    const filter = new Redactor(['abcdefgh']);
    filter.push(Buffer.from('abcdefg'));
    expect(filter.finish().toString()).toBe('[REDACTED]');
    expect(filter.finish().length).toBe(0);
    expect(() => filter.push(Buffer.from('!'))).toThrow();
  });
  it('redacta Unicode partido sin decodificar y conserva datos binarios inválidos', () => {
    const secret = '漢😀ñéabc';
    const raw = Buffer.from(secret);
    const source = Buffer.concat([Buffer.from([0xff, 0x80, 0]), raw, Buffer.from([0xfe, 0])]);
    expect(redact([secret], Array.from(source, byte => Buffer.from([byte])))).toEqual(Buffer.concat([
      Buffer.from([0xff, 0x80, 0]), Buffer.from('[REDACTED]'), Buffer.from([0xfe, 0]),
    ]));
  });
  it('detecta URLSearchParams con espacios partido en cada posición, sin confundir un + literal', () => {
    const secret = 'a b+c é 漢';
    const form = Buffer.from(new URLSearchParams({ x: secret }).toString().slice(2));
    for (let i = 0; i <= form.length; i++) {
      expect(redact([secret], [form.subarray(0, i), form.subarray(i)]).toString()).toBe('[REDACTED]');
    }
    expect(redact([secret], [Buffer.from('a+b+c+é+漢!')]).toString()).toBe('a+b+c+é+漢!');
  });
  it('rechaza registro vacío, secretos no string, 7 bytes y límites excesivos; acepta 8 bytes', () => {
    expect(() => new Redactor([])).toThrow(expect.objectContaining({ code: 'H-RDX-EMPTY' }));
    expect(() => new Redactor(undefined as unknown as string[])).toThrow(expect.objectContaining({ code: 'H-RDX-EMPTY' }));
    for (const secret of ['1234567', 12345678, null]) {
      expect(() => new Redactor([secret as string])).toThrow(expect.objectContaining({ code: 'H-RDX-SHORT' }));
    }
    expect(() => new Redactor(['12345678'])).not.toThrow();
    expect(() => new Redactor(['éééé'])).not.toThrow();
    expect(() => new Redactor(['x'.repeat(129)])).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
    expect(() => new Redactor(Array.from({ length: 17 }, () => '12345678'))).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
  });
  it('el matcher conserva estado entre bloques y detecta varios secretos', () => {
    const matcher = createMatcher(['abcdefgh', 'ijklmnop']);
    expect(matcher.feed(Buffer.from('xxabcd'))).toBe(false);
    expect(matcher.feed(Buffer.from('efgh!ijkl'))).toBe(true);
    expect(matcher.feed(Buffer.from('mnop!'))).toBe(true);
    expect(matcher.feed(Buffer.from('xyz!'))).toBe(false);
  });
  it('F3 límite de 20000 estados: 16 secretos ASCII distintos de 128 bytes exceden el autómata', () => {
    const next = random(0x13579bdf);
    const secrets = Array.from({ length: 16 }, () => Array.from({ length: 128 }, () => String.fromCharCode(32 + next(95))).join(''));
    expect(new Set(secrets).size).toBe(16);
    expect(secrets.every(secret => Buffer.byteLength(secret) === 128)).toBe(true);
    // Conteo independiente del trie mediante prefijos únicos, sin invocar buildDfa.
    const prefixes = new Set<string>(['']);
    for (const secret of secrets) for (const pattern of secretVariants(secret)) {
      for (let length = 1; length <= pattern.length; length++) prefixes.add(pattern.subarray(0, length).toString('hex'));
    }
    expect(prefixes.size).toBeGreaterThan(20000);
    expect(() => new Redactor(secrets.slice(0, 2))).not.toThrow();
    expect(() => new Redactor(secrets)).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
  });
  it('F1 memoria redactor: 10 MiB, retención <=4096, <5 s y consumo aislado', () => {
    const filter = new Redactor(['SYN-Secret123', 'SYN-Other456']);
    const block = Buffer.alloc(64 * 1024, 0x78);
    const start = performance.now();
    let total = 0;
    for (let i = 0; i < 160; i++) total += filter.push(block).length;
    total += filter.finish().length;
    const elapsed = performance.now() - start;
    process.stdout.write(`RDX_BENCH elapsedMs=${elapsed.toFixed(1)} retained=${filter.maxRetainedBytes}\n`);
    expect(total).toBe(10 * 1024 * 1024);
    expect(elapsed).toBeLessThan(5000);
    expect(filter.maxRetainedBytes).toBeLessThanOrEqual(4096);
    checkIsolatedMemory('redactor');
  }, 20000);
  it('acota la retención con prefijos y cadenas de solapamientos de longitud arbitraria', () => {
    const filter = new Redactor(['aaaaaaaa', 'SYN-Secret123']);
    for (let i = 0; i < 100; i++) {
      expect(filter.push(Buffer.alloc(65536, 0x61)).length).toBe(0);
      expect(filter.retainedBytes).toBeLessThanOrEqual(filter.dfa.maxLength);
    }
    expect(filter.finish().toString()).toBe('[REDACTED]');
    const prefix = new Redactor(['SYN-Secret123']);
    prefix.push(Buffer.from('SYN-Secret12'));
    expect(prefix.maxRetainedBytes).toBe(Buffer.byteLength('SYN-Secret12'));
  });
});
