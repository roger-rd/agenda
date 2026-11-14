import { checkOrigin } from './origin-policy';
export const originCases: [unknown, unknown, 'allow' | 'deny'][] = [
  ['https://permitido.test', 'cross-site', 'allow'], ['https://otro.test', undefined, 'deny'],
  ['null', undefined, 'deny'], ['', undefined, 'deny'], ['https://permitido.test/ruta', undefined, 'deny'],
  ['https://permitido.test/', undefined, 'deny'], ['ftp://permitido.test', undefined, 'deny'],
  ['https://permitido.test, https://otro.test', undefined, 'deny'],
  [undefined, 'same-origin', 'allow'], [undefined, 'none', 'allow'], [undefined, undefined, 'allow'],
  [undefined, 'same-site', 'deny'], [undefined, 'cross-site', 'deny'], [undefined, 'foo', 'deny'],
];
it.each([...originCases, [['https://permitido.test'], undefined, 'deny'], [undefined, ['none'], 'deny'],
  ['https://u:p@permitido.test', undefined, 'deny']] as typeof originCases)('Origin %p y sitio %p → %s', (origin, secFetchSite, result) => {
  expect(checkOrigin({ origin, secFetchSite, allowed: ['https://permitido.test'] })).toBe(result);
});
