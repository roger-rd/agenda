import { TARGET, validate } from '../../scripts/harness/c8-target.cjs';
const target = { ...TARGET, user: TARGET.owner };
describe('C8 destino fijo', () => {
  it('no invoca getters ni acepta propiedades heredadas', () => {
    const get = jest.fn(() => { throw new Error('private'); });
    expect(() => validate(Object.defineProperty({ ...target }, 'database', { get }), 'owner')).toThrow('target_invalid');
    expect(get).not.toHaveBeenCalled(); expect(() => validate(Object.create(target), 'owner')).toThrow('target_invalid');
  });
  it('acepta exclusivamente los dos roles actuales', () => {
    expect(validate(target, 'owner')).toBe(true);
    expect(validate({ ...target, user: TARGET.app }, 'app')).toBe(true);
  });
  it.each([['database', 'agenda_dev'], ['database', 'agenda_test\n'], ['host', 'localhost'], ['port', 5432],
    ['port', '5433'], ['major', 15], ['major', 17], ['major', '16'], ['user', 'agenda_test_uow_app'],
    ['user', 'agenda_dev_owner'], ['user', 'owner'], ['user', 'agenda_test_owner\0'], ['user', 'AGENDA_TEST_OWNER'],
    ['user', 'á'], ['user', '"'], ['user', 'x'.repeat(1000)]])('rechaza %s/%s sin eco', (key, value) => {
    expect(() => validate({ ...target, [key]: value }, 'owner')).toThrow(/^target_(invalid|role_invalid)$/);
  });
  it.each([null, undefined, false, 'target', 16])('rechaza estructura %#', value => {
    expect(() => validate(value, 'owner')).toThrow('target_invalid');
  });
});
