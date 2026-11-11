import * as native from '@node-rs/argon2';
import { InvalidInputError, ServiceUnavailableError } from '../common/errors/domain-error';
import { Argon2idPasswordHasher, PASSWORD_HASH_POLICY } from './password-hasher';

jest.mock('@node-rs/argon2', () => {
  const actual = jest.requireActual<typeof import('@node-rs/argon2')>('@node-rs/argon2');
  return { ...actual, hash: jest.fn(actual.hash), verify: jest.fn(actual.verify), parseOptions: jest.fn(actual.parseOptions) };
});
const actual = jest.requireActual<typeof import('@node-rs/argon2')>('@node-rs/argon2');
const hasher = new Argon2idPasswordHasher();
const password = 'clave privada de prueba';
let phc: string;
beforeAll(async () => { phc = await hasher.hash(password); });
beforeEach(() => {
  jest.mocked(native.hash).mockReset().mockImplementation(actual.hash);
  jest.mocked(native.verify).mockReset().mockImplementation(actual.verify);
  jest.mocked(native.parseOptions).mockReset().mockImplementation(actual.parseOptions);
});

describe('Argon2idPasswordHasher', () => {
  it('genera política fija, formato y sales distintas', async () => {
    expect(Object.isFrozen(PASSWORD_HASH_POLICY)).toBe(true);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(phc).toHaveLength(97);
    expect(phc.length).toBeGreaterThanOrEqual(40);
    expect(phc.length).toBeLessThanOrEqual(512);
    const other = await hasher.hash(password);
    expect(other.split('$')[4]).not.toBe(phc.split('$')[4]);
    expect(actual.parseOptions(phc)).toEqual(PASSWORD_HASH_POLICY);
    expect(native.hash).toHaveBeenCalledWith(password, PASSWORD_HASH_POLICY);
  });
  it('verifica correcta e incorrecta mediante biblioteca', async () => {
    expect(await hasher.verify(phc, password)).toBe(true);
    expect(await hasher.verify(phc, password + '!')).toBe(false);
    expect(native.verify).toHaveBeenCalledTimes(2);
  });
  it('usa NFC en ambos sentidos y conserva espacios', async () => {
    const nfd = 'e\u0301'.repeat(15), nfc = 'é'.repeat(15);
    expect(await hasher.verify(await hasher.hash(nfd), nfc)).toBe(true);
    expect(await hasher.verify(await hasher.hash(nfc), nfd)).toBe(true);
    const spaced = await hasher.hash(' ' + password + ' ');
    expect(await hasher.verify(spaced, ' ' + password + ' ')).toBe(true);
    expect(await hasher.verify(spaced, password)).toBe(false);
  });
  it.each([null, {}, '', 'a'.repeat(14), '😀'.repeat(129), password + '\0', password + '\ud800', password + '\udc00'])('rechaza contraseña inválida %# sin hash/verify nativos', async input => {
    await expect(hasher.hash(input)).rejects.toThrow(InvalidInputError);
    await expect(hasher.hash(input)).rejects.toThrow('Contraseña inválida.');
    expect(await hasher.verify(phc, input)).toBe(false);
    expect(native.hash).not.toHaveBeenCalled();
    expect(native.verify).not.toHaveBeenCalled();
    expect(native.parseOptions).toHaveBeenCalledTimes(1);
  });
  it.each([15, 128])('hash y verify admiten %i emoji', async count => {
    const input = '😀'.repeat(count);
    expect(await hasher.verify(await hasher.hash(input), input)).toBe(true);
  });
  const hostile: Array<(s: string) => unknown> = [
    () => null, () => 1, () => '', () => 'x'.repeat(39), () => 'x'.repeat(513), () => 'x'.repeat(100000),
    s => s.slice(0, -1), s => s + '\n', s => s + '\r\n', s => ' ' + s, s => s + '$extra',
    s => s.replace('argon2id', 'argon2i'), s => s.replace('argon2id', 'argon2d'), s => s.replace('v=19', 'v=16'),
    ...['m=19455,t=2,p=1', 'm=65537,t=2,p=1', 'm=19456,t=1,p=1', 'm=19456,t=5,p=1',
      'm=19456,t=2,p=0', 'm=19456,t=2,p=2', 'm=019456,t=2,p=1', 'm=19456,t=02,p=1',
      'm=19456,t=2,p=01', 'm=+19456,t=2,p=1', 'm=-19456,t=2,p=1',
      'm=19456,m=19456,t=2,p=1', 'm=19456,t=2,t=2,p=1', 'm=19456,t=2,p=1,p=1',
      't=2,m=19456,p=1', 'm=19456,t=2,p=1,x=1', 'm=999999999999999999999,t=2,p=1',
    ].map(params => (s: string) => s.replace('m=19456,t=2,p=1', params)),
    s => s.replace(/\$([^$]+)$/, '$$$1='),
    s => s.split('$').map((part, i) => i === 4 ? part + 'A' : part).join('$'),
    s => s.split('$').map((part, i) => i === 4 ? part.slice(1) : part).join('$'),
  ];
  it.each(hostile)('rechaza PHC hostil %# antes de parsear o verificar', async transform => {
    const input = transform(phc);
    expect(await hasher.verify(input, password)).toBe(false);
    expect(hasher.needsRehash(input)).toBe(false);
    expect(native.parseOptions).not.toHaveBeenCalled();
    expect(native.verify).not.toHaveBeenCalled();
  });
  it.each(['algorithm', 'version', 'memoryCost', 'timeCost', 'parallelism', 'saltLen', 'outputLen'] as const)('rechaza incoherencia de %s', key => {
    jest.mocked(native.parseOptions).mockReturnValue({ ...actual.parseOptions(phc), [key]: 0 });
    expect(hasher.needsRehash(phc)).toBe(false);
    return expect(hasher.verify(phc, password)).resolves.toBe(false).then(() => {
      expect(native.verify).not.toHaveBeenCalled();
    });
  });
  it('compara parámetros admitidos para rehash', async () => {
    expect(hasher.needsRehash(phc)).toBe(false);
    for (const options of [{ memoryCost: 19457 }, { timeCost: 3 }, { memoryCost: 65536, timeCost: 4 }]) {
      const stronger = await actual.hash(password, { ...PASSWORD_HASH_POLICY, ...options });
      expect(await hasher.verify(stronger, password)).toBe(true);
      expect(hasher.needsRehash(stronger)).toBe(true);
    }
  });
  it('contiene errores nativos sin mensajes ni logs con secretos', async () => {
    const logs = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error'), jest.spyOn(console, 'warn')];
    try {
      const failure = new Error(password + phc);
      jest.mocked(native.parseOptions).mockImplementation(() => { throw failure; });
      expect(await hasher.verify(phc, password)).toBe(false);
      expect(hasher.needsRehash(phc)).toBe(false);
      expect(native.verify).not.toHaveBeenCalled();
      jest.mocked(native.parseOptions).mockImplementation(actual.parseOptions);
      jest.mocked(native.verify).mockRejectedValue(failure);
      expect(await hasher.verify(phc, password)).toBe(false);
      jest.mocked(native.hash).mockRejectedValue(failure);
      await expect(hasher.hash(password)).rejects.toThrow(ServiceUnavailableError);
      try { await hasher.hash(password); } catch (error) {
        expect(String(error)).not.toContain(password);
        expect(String(error)).not.toContain(phc);
        expect((error as Error).cause).toBeUndefined();
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { logs.forEach(log => log.mockRestore()); }
  });
});
