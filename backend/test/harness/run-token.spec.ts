import { mintToken, verifyToken } from '../../scripts/harness/run-token.cjs';

const epoch = 1800000000;
const now = () => epoch * 1000;
const token = `${'ab'.repeat(16)}.${epoch}`;
describe('run token (UN-D12 parcial)', () => {
  it('emite formato y verifica con reloj inyectado', () => {
    expect(mintToken({ now, randomBytes: size => Buffer.alloc(size, 0xab) })).toBe(token);
    expect(verifyToken(token, { now })).toEqual({ ok: true, runId: 'ab'.repeat(16), issuedAt: epoch });
  });
  it.each([[1500, true], [1501, false], [-5, true], [-6, false], [100000, false]])('borde de edad %i', (age, ok) => {
    const result = verifyToken(token, { now: () => (epoch + Number(age)) * 1000 });
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.code).toBe(Number(age) < 0 ? 'H-TOKEN-FUTURE' : 'H-TOKEN-EXPIRED');
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each([undefined, null, 123, {}, '', ` ${token}`, `${token} `, `${token}\n`, token.toUpperCase(),
    token.slice(1), token.replace('.', ':'), `${'a'.repeat(32)}.123456789`, `${'a'.repeat(32)}.123456789012`])('rechaza formato %#', value => {
    expect(verifyToken(value, { now })).toEqual({ ok: false, code: 'H-TOKEN-FORMAT' });
  });
  it('rechaza mutaciones inválidas en cada posición', () => {
    for (let i = 0; i < token.length; i++) {
      expect(verifyToken(token.slice(0, i) + '!' + token.slice(i + 1), { now })).toEqual({ ok: false, code: 'H-TOKEN-FORMAT' });
    }
  });
  it('produce identificadores distintos con entropía inyectada', () => {
    let sequence = 0;
    const tokens = Array.from({ length: 100 }, () => mintToken({ now, randomBytes: size => Buffer.alloc(size, sequence++) }));
    expect(new Set(tokens).size).toBe(100);
  });
  it('valida entropía, epoch y reloj no finito', () => {
    expect(() => mintToken({ now, randomBytes: () => Buffer.alloc(15) })).toThrow('Formato de testigo no válido.');
    expect(() => mintToken({ now: () => 0, randomBytes: size => Buffer.alloc(size) })).toThrow('Formato de testigo no válido.');
    expect(verifyToken(token, { now: () => NaN })).toEqual({ ok: false, code: 'H-TOKEN-FORMAT' });
    expect(verifyToken(`${'a'.repeat(32)}.10000000000`, { now: () => 10000000000000 }).ok).toBe(true);
  });
});
