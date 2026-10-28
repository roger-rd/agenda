import { sqlstateClass } from './sqlstate';
it.each(['23505', 'XX000', '08006'])('extrae clase %s', code => expect(sqlstateClass(code)).toBe(code.slice(0, 2)));
it.each([null, undefined, 23505, '', '23505\n', 'xx000', '235050', '2350', ' 23505'])('rechaza SQLSTATE inválido %#', code => expect(sqlstateClass(code)).toBeUndefined());
