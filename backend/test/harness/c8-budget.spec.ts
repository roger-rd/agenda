import { LIMITS, validate } from '../../scripts/harness/c8-budget.cjs';
const budget = { wrapper: 1, child: 1, app: 20, preflight: 6 };
describe('C8 conexiones', () => {
  it.each([6, 7])('límite normativo literal de preflight %i, independiente de LIMITS', connections => {
    if (connections === 6) expect(validate({ ...budget, preflight: connections })).toBe(true);
    else expect(() => validate({ ...budget, preflight: connections })).toThrow('budget_invalid');
  });
  it('reserva 2 owner, máximo 20 app y 6 preflight', () => {
    expect(LIMITS.owner).toBe(2); expect(validate(budget)).toBe(true);
  });
  it.each(['wrapper', 'child', 'app', 'preflight'] as const)('valida %s', key => {
    for (const n of [-1, 1.5, NaN, Infinity, LIMITS[key] + 1]) expect(() => validate({ ...budget, [key]: n })).toThrow('budget_invalid');
    for (let n = 0; n <= LIMITS[key]; n++) expect(validate({ ...budget, [key]: n })).toBe(true);
  });
});
