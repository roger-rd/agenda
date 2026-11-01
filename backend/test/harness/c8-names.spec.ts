import { valid, validRun, quote, mark, parseMark, generate } from '../../scripts/harness/c8-names.cjs';
import { NAME, RUN, seeded } from './support/c8-fakes';
describe('C8 nombres', () => {
  it.each(['uow_2611011200_ABC123_1', 'uow_2611011200_abC123_1'])('rechaza mayúsculas solo en alea: %s', name => {
    expect(valid(name.toLowerCase())).toBe(true);
    expect(valid(name)).toBe(false); expect(() => quote(name)).toThrow('schema_invalid');
  });
  it('genera UTC y cita un identificador validado', () => {
    expect(generate({ now: () => Date.UTC(2026, 10, 1, 12), random: () => 'abc123' }, 1)).toBe(NAME);
    expect(quote(NAME)).toBe(`"${NAME}"`); expect(parseMark(mark(RUN))).toBe(RUN);
  });
  it.each(['', `${NAME}\n`, `${NAME}\0`, NAME.toUpperCase(), `${NAME}"`, NAME.replace('abc123', 'ábć123'),
    NAME.replace('abc123', 'abc12'), NAME.replace('abc123', 'abc1234'), NAME.replace(/_1$/, '_1000'),
    NAME.replace(/_1$/, '_-1'), 'public', 'uow_2611011200_abc123_'])('rechaza %j', value => {
    expect(valid(value)).toBe(false); expect(() => quote(value)).toThrow('schema_invalid');
  });
  it.each(['', `${RUN}\n`, RUN.toUpperCase(), 'x'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '\0'])('marca inválida %#', run => {
    expect(validRun(run)).toBe(false); expect(() => mark(run)).toThrow('run_invalid');
    expect(parseMark(`agenda-test/v1/run/${run}`)).toBeNull();
  });
  it('propiedades reproducibles, límites y marca exacta', () => {
    const random = seeded();
    for (let i = 0; i < 200; i++) {
      const entropy = random().toString(36).padStart(6, '0').slice(-6);
      const name = generate({ now: () => Date.UTC(2000 + random() % 100, random() % 12, 1), random: () => entropy }, random() % 1000);
      expect(valid(name)).toBe(true); expect(valid(`${name}\n`)).toBe(false);
    }
    expect(parseMark(mark(RUN) + 'x')).toBeNull(); expect(parseMark('other/' + RUN)).toBeNull();
  });
  it.each([NaN, Infinity, -1, Date.UTC(2100, 0), 1.5])('reloj inválido %s', time => {
    expect(() => generate({ now: () => time, random: () => 'abc123' }, 1)).toThrow('schema_invalid');
  });
  it.each([-1, 1000, 1.5, NaN])('ordinal inválido %s', index => {
    expect(() => generate({ now: () => Date.UTC(2026, 0), random: () => 'abc123' }, index)).toThrow();
  });
});
