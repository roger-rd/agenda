import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildChildEnv, assertChildEnvShape } from '../../scripts/harness/child-env.cjs';
import { CHILD_ENV_KEYS, PGPASSFILE_INERT } from '../../scripts/harness/constants.cjs';
import { HarnessError } from '../../scripts/harness/harness-error.cjs';
import { THIRD_PARTY_SECRET } from './support/synthetic-secrets';

const token = `${'ab'.repeat(16)}.1800000000`;
const base = { NODE_ENV: 'test', AGENDA_DB_TEST_TOKEN: token, PGPASSFILE: PGPASSFILE_INERT, NO_COLOR: '1' };

/** macOS añade esta variable al arrancar Node incluso con env -i;
 * /usr/bin/env permite comprobar por separado el entorno exacto entregado. */
function assertNodeChildKeys(keys: string[], artifact: unknown, platform: string, expected: string[]) {
  const osKey = '__CF_USER_TEXT_ENCODING';
  let actual = keys;
  if (keys.includes(osKey)) {
    expect(platform).toBe('darwin');
    expect(typeof artifact).toBe('string');
    expect(artifact).toMatch(/^0x[0-9A-F]+:0x[0-9A-F]+:0x[0-9A-F]+$(?![\s\S])/);
    actual = keys.filter(key => key !== osKey);
    expect(keys.filter(key => key === osKey)).toHaveLength(1);
  }
  expect([...actual].sort()).toEqual([...expected].sort());
}

function assertExactEnv(env: Readonly<Record<string, string>>) {
  if (!existsSync('/usr/bin/env')) throw new Error('Prueba obligatoria: /usr/bin/env no existe en esta plataforma.');
  const output = execFileSync('/usr/bin/env', [], { env, shell: false, encoding: 'utf8', timeout: 10000 });
  expect(output.endsWith('\n')).toBe(true);
  expect(output.slice(0, -1).split('\n').sort()).toEqual(Object.entries(env).map(([key, value]) => `${key}=${value}`).sort());
}

describe('entorno del hijo', () => {
  it('construye exactamente las claves autorizadas y congela el resultado', () => {
    const env = buildChildEnv({ token });
    expect(env).toEqual(base);
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => assertChildEnvShape(env)).not.toThrow();
    const withTmp = buildChildEnv({ token, tmpdir: '/synthetic/tmp' });
    expect(Object.keys(withTmp).sort()).toEqual([...CHILD_ENV_KEYS].sort());
    expect(withTmp.TMPDIR).toBe('/synthetic/tmp');
    expect(() => assertChildEnvShape(withTmp)).not.toThrow();
  });
  it('ignora parámetros extra y un entorno padre simulado envenenado', () => {
    const poisoned = { token, parentEnv: { PATH: '/synthetic', NODE_OPTIONS: '--require=poison',
      PGHOST: 'outside', DATABASE_PASSWORD: THIRD_PARTY_SECRET }, ...{ PATH: '/outside', HOME: '/outside' } };
    expect(buildChildEnv(poisoned)).toEqual(base);
    expect(JSON.stringify(buildChildEnv(poisoned))).not.toContain(THIRD_PARTY_SECRET);
  });
  it.each([undefined, '/synthetic/tmp'])('/usr/bin/env recibe exactamente claves y valores (%s)', tmpdir => {
    assertExactEnv(buildChildEnv({ token, tmpdir }));
  });
  it('el padre envenenado no se cuela en el entorno real de /usr/bin/env', () => {
    const poison = { AGENDA_SYNTHETIC_POISON: THIRD_PARTY_SECRET, PGHOST: 'synthetic-outside',
      NODE_OPTIONS: '--no-warnings' };
    const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, poison);
      assertExactEnv(buildChildEnv({ token }));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  it.each([undefined, '/synthetic/tmp'])('Node recibe las claves construidas con el único artefacto macOS validado (%s)', tmpdir => {
    const env = buildChildEnv({ token, tmpdir });
    const output = execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify({keys:Object.keys(process.env).sort(),artifact:process.env.__CF_USER_TEXT_ENCODING}))'], {
      env, shell: false, encoding: 'utf8', timeout: 10000,
    });
    const result = JSON.parse(output) as { keys: string[]; artifact?: unknown };
    assertNodeChildKeys(result.keys, result.artifact, process.platform, Object.keys(env));
  });
  it('admite únicamente el artefacto válido en darwin', () => {
    expect(() => assertNodeChildKeys([...Object.keys(base), '__CF_USER_TEXT_ENCODING'], '0x1F5:0x0:0x8', 'darwin', Object.keys(base))).not.toThrow();
  });
  it.each([
    { platform: 'darwin', artifact: 'invalid', extra: '__CF_USER_TEXT_ENCODING' },
    { platform: 'darwin', artifact: '0x1F5:0x0:0x8\n', extra: '__CF_USER_TEXT_ENCODING' },
    { platform: 'linux', artifact: '0x1F5:0x0:0x8', extra: '__CF_USER_TEXT_ENCODING' },
    { platform: 'darwin', artifact: '0x1F5:0x0:0x8', extra: 'UNEXPECTED' },
  ])('rechaza tolerancia inválida %#', ({ platform, artifact, extra }) => {
    expect(() => assertNodeChildKeys([...Object.keys(base), extra], artifact, platform, Object.keys(base))).toThrow();
  });
  it.each(['', 'relative', '../tmp', null, false, 1, {}, '/bad\0path', '/' + 'a'.repeat(1024)])('rechaza tmpdir inválido %#', tmpdir => {
    expect(() => buildChildEnv({ token, tmpdir })).toThrow(expect.objectContaining({ code: 'H-CHILD-TMPDIR' }));
  });
  it('acepta el límite de 1024 caracteres', () => {
    expect(buildChildEnv({ token, tmpdir: '/' + 'a'.repeat(1023) }).TMPDIR).toHaveLength(1024);
  });
  it.each([undefined, null, '', `${token}\n`, token.toUpperCase(), THIRD_PARTY_SECRET])('rechaza testigo inválido %#', value => {
    expect(() => buildChildEnv({ token: value })).toThrow(expect.objectContaining({ code: 'H-TOKEN-FORMAT' }));
  });
  it.each([
    { ...base, NODE_ENV: 'production' }, { ...base, PGPASSFILE: '/tmp/pass' }, { ...base, NO_COLOR: '0' },
    { ...base, AGENDA_DB_TEST_TOKEN: 'invalid' }, { ...base, TMPDIR: 'relative' }, { ...base, TMPDIR: undefined },
    { ...base, PATH: '/synthetic' }, { ...base, PGHOST: 'outside' }, { ...base, NODE_OPTIONS: '--inspect' },
    { ...base, [Symbol('extra')]: 'bad' }, {}, null, [], Object.create(base) as unknown,
  ])('rechaza mutaciones de forma %#', env => {
    expect(() => assertChildEnvShape(env)).toThrow(expect.objectContaining({ code: 'H-CHILD-ENV' }));
  });
  it.each(Object.keys(base))('rechaza la ausencia de %s', key => {
    const env: Record<string, string> = { ...base };
    delete env[key];
    expect(() => assertChildEnvShape(env)).toThrow(HarnessError);
  });
  it('rechaza getters sin ejecutarlos', () => {
    const get = jest.fn(() => 'test');
    const env = Object.defineProperty({ ...base }, 'NODE_ENV', { get });
    expect(() => assertChildEnvShape(env)).toThrow(HarnessError);
    expect(get).not.toHaveBeenCalled();
  });
});
