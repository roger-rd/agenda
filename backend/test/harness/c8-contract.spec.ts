import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { C8_CONTRACT, isC8Ready } from '../../scripts/harness/c8-contract.cjs';

describe('C8 provisional', () => {
  it('fija explícitamente C8 deshabilitado y sus rutas provisionales', () => {
    expect(C8_CONTRACT.c8Implemented).toBe(false);
    expect(C8_CONTRACT.requiredFiles).toEqual(['scripts/harness/preflight.cjs', 'scripts/harness/lease.cjs',
      'scripts/harness/sweep.cjs', 'test/db/global-setup.cjs', 'test/db/support/describe-db.ts']);
    expect(Object.isFrozen(C8_CONTRACT)).toBe(true);
    expect(Object.isFrozen(C8_CONTRACT.requiredFiles)).toBe(true);
  });
  it('ninguna ruta provisional existe en el repositorio', () => {
    for (const file of C8_CONTRACT.requiredFiles) expect(fs.existsSync(path.resolve(__dirname, '../..', file))).toBe(false);
  });
  it.each(Array.from({ length: 32 }, (_, mask) => mask))('falla cerrado en combinación %i', mask => {
    const exists = (file: string) => C8_CONTRACT.requiredFiles.some((required, i) =>
      file === path.join('/synthetic', required) && Boolean(mask & (1 << i)));
    const result = isC8Ready('/synthetic', { exists });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(C8_CONTRACT.requiredFiles.filter((_, i) => !(mask & (1 << i))));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
  });
  it('caracteriza ambos flags y los 32 subconjuntos en una copia aislada sin modificar el contrato', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/harness/c8-contract.cjs'), 'utf8');
    for (const flag of [false, true]) {
      const module = { exports: {} as typeof import('../../scripts/harness/c8-contract.cjs') };
      vm.runInNewContext(source.replace('c8Implemented: false', `c8Implemented: ${flag}`), {
        module, require: (name: string) => { if (name !== 'node:path') throw new Error('Importación no permitida'); return path; },
      });
      for (let mask = 0; mask < 32; mask++) {
        const exists = (file: string) => C8_CONTRACT.requiredFiles.some((required, i) =>
          file === path.join('/synthetic', required) && Boolean(mask & (1 << i)));
        expect(module.exports.isC8Ready('/synthetic', { exists }).ready).toBe(flag && mask === 31);
      }
    }
    expect(C8_CONTRACT.c8Implemented).toBe(false);
  });
});
