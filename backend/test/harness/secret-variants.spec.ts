import { secretVariants } from '../../scripts/harness/secret-variants.cjs';
import { Redactor } from '../../scripts/harness/redactor.cjs';
import { base64Core, encodings, random, secretsCorpus } from './support/redaction-corpus';

describe('secretVariants: codificadores independientes', () => {
  it('F3 porcentajes minúsculos: cuatro alfabetos independientes y redacción fragmentada', () => {
    const secret = "SYN-é # / + = & ñ!~*'();?:@$,[]";
    const alphanumerics = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const alphabets = ["-._!~*'()", '-._~', '*-._', "-_.!~*'();/?:@&=+$,#"];
    const hex = '0123456789abcdef';
    const variants = secretVariants(secret).map(value => value.toString());
    for (const punctuation of alphabets) {
      const allowed = new Set(alphanumerics + punctuation);
      const encoded = Array.from(Buffer.from(secret), byte => allowed.has(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '%' + hex[byte >> 4] + hex[byte & 15]).join('');
      expect(encoded).toContain('%c3%a9'); expect(encoded).toContain('%c3%b1');
      expect(variants).toContain(encoded);
      const bytes = Buffer.from(encoded);
      for (const split of [1, encoded.indexOf('%') + 1, encoded.indexOf('%') + 2, Math.floor(bytes.length / 2)]) {
        const filter = new Redactor([secret]);
        const output = Buffer.concat([filter.push(bytes.subarray(0, split)), filter.push(bytes.subarray(split)), filter.finish()]);
        expect(output.toString()).toBe('[REDACTED]');
        expect(output.includes(bytes)).toBe(false);
      }
    }
  });
  it('cubre 1500 secretos, incluidos JSON, inspect, URI y formularios', () => {
    for (const secret of secretsCorpus(1500)) {
      const variants = secretVariants(secret).map(value => value.toString());
      for (const encoded of encodings(secret)) {
        expect(encoded.length).toBeGreaterThanOrEqual(12);
        expect(variants.some(value => encoded.includes(value))).toBe(true);
      }
      expect(new Set(variants).size).toBe(variants.length);
      expect(variants.every(value => Buffer.byteLength(value) >= 6)).toBe(true);
    }
  });
  it('cubre núcleos base64/base64url con prefijos y sufijos aleatorios de 0 a 6 bytes', () => {
    const next = random(0x191122);
    for (const secret of secretsCorpus(1500)) {
      const raw = Buffer.from(secret);
      const variants = secretVariants(secret).map(value => value.toString());
      for (let p = 0; p <= 6; p++) {
        const prefix = Buffer.from(Array.from({ length: p }, () => next(256)));
        const suffix = Buffer.from(Array.from({ length: next(7) }, () => next(256)));
        for (const encoding of ['base64', 'base64url'] as const) {
          const encoded = Buffer.concat([prefix, raw, suffix]).toString(encoding);
          const core = base64Core(encoded, p, raw.length);
          expect(core.length).toBeGreaterThanOrEqual(12);
          expect(variants).toContain(core);
        }
      }
    }
  });
  it('añade + para espacios conservando %20 y escapando + literal', () => {
    const secret = 'a b+c é 漢';
    const form = new URLSearchParams({ x: secret }).toString().slice(2);
    const variants = secretVariants(secret).map(value => value.toString());
    expect(variants).toContain(form);
    expect(variants).toContain(form.replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()));
    expect(variants).toContain(form.replace(/\+/g, '%20'));
    expect(variants).not.toContain('a+b+c+é+漢');
    const noSpace = secretVariants('abc+defghi').map(value => value.toString());
    expect(noSpace).not.toContain('abc defghi');
    expect(new Set(noSpace).size).toBe(noSpace.length);
  });
  it('enumera Unicode JSON con pares sustitutos y las dos cajas', () => {
    const variants = secretVariants('漢字😀éñ').map(value => value.toString());
    expect(variants).toContain('\\u6f22\\u5b57\\ud83d\\ude00\\u00e9\\u00f1');
    expect(variants).toContain('\\u6F22\\u5B57\\uD83D\\uDE00\\u00E9\\u00F1');
  });
});
