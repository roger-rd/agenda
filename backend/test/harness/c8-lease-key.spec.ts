import { createRegistry } from '../../scripts/harness/c8-lease-key.cjs';
import { NAME, seeded } from './support/c8-fakes';
describe('C8 claves', () => {
  it.each([['lease', NAME, undefined, '1513499141925193319'], ['test-lock', NAME, 'x', '3215754263976401573'],
    ['harness', 'global-run', undefined, '4095698742242691401']])('vector dorado %s', (purpose, name, subkey, expected) => {
    expect(createRegistry().key(purpose!, name!, subkey)).toBe(expected);
  });
  it('rangos disjuntos, determinismo y propiedades con semilla fija', () => {
    const registry = createRegistry(); const random = seeded(); const results = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = `uow_2611011200_${random().toString(36).padStart(6, '0').slice(-6)}_${i}`;
      for (const [purpose, tag, subkey] of [['lease', 1, undefined], ['test-lock', 2, 'x']] as const) {
        const value = registry.key(purpose, name, subkey);
        expect(registry.key(purpose, name, subkey)).toBe(value); expect(BigInt(value) >> 60n).toBe(BigInt(tag)); results.add(value);
      }
    }
    expect(results.size).toBe(400); expect(BigInt(registry.key('harness', 'global-run')) >> 60n).toBe(3n);
  });
  it.each(['other', '', 'LEASE', 'lease\n', 'léase', '\0'])('propósito inválido %j', purpose => {
    expect(() => createRegistry().key(purpose, NAME)).toThrow('key_invalid');
  });
  it.each(['', 'X', 'á', 'x\n', 'x\0', 'x/y', 'x'.repeat(33), "'"])('subclave inválida %j', subkey => {
    expect(() => createRegistry().key('test-lock', NAME, subkey)).toThrow('key_invalid');
  });
  it('subclave obligatoria solo en test-lock y dominio harness cerrado', () => {
    const r = createRegistry(); expect(() => r.key('test-lock', NAME)).toThrow();
    expect(() => r.key('lease', NAME, 'x')).toThrow(); expect(() => r.key('harness', NAME)).toThrow();
    expect(() => r.key('harness', 'global-run\n')).toThrow(); expect(() => r.key('lease', NAME + '\n')).toThrow();
    expect(r.key('test-lock', NAME, 'x'.repeat(32))).toMatch(/^\d+$/);
  });
  it.each(['lease', 'test-lock'])('colisión %s envenena todo el registro', purpose => {
    const r = createRegistry(() => new Uint8Array(32)); const subkey = purpose === 'test-lock' ? 'x' : undefined;
    r.key(purpose, NAME, subkey);
    expect(() => r.key(purpose, NAME.replace(/1$/, '2'), subkey)).toThrow('key_collision');
    expect(() => r.key(purpose, NAME, subkey)).toThrow('key_collision');
    expect(() => r.key('harness', 'global-run')).toThrow('key_collision');
  });
  it('valida digest e independiza tags incluso con hash falso', () => {
    expect(() => createRegistry(() => new Uint8Array(8)).key('lease', NAME)).toThrow('hash_invalid');
    const r = createRegistry(() => new Uint8Array(32));
    expect(new Set([r.key('lease', NAME), r.key('test-lock', NAME, 'x'), r.key('harness', 'global-run')]).size).toBe(3);
  });
});
