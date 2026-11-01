'use strict';
const TARGET = Object.freeze({ database: 'agenda_test', host: '127.0.0.1', port: 5433,
  major: 16, owner: 'agenda_test_owner', app: 'agenda_test_app' });
/** @param {unknown} input @param {'owner'|'app'} role */
function validate(input, role) {
  if (!input || typeof input !== 'object' || !['owner', 'app'].includes(role)) throw new Error('target_invalid');
  const value = /** @type {Record<string, unknown>} */ (input);
  for (const key of ['database', 'host', 'port', 'major']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== TARGET[/** @type {'database'|'host'|'port'|'major'} */ (key)]) throw new Error('target_invalid');
  }
  const user = Object.getOwnPropertyDescriptor(value, 'user');
  if (!user || !Object.hasOwn(user, 'value') || user.value !== TARGET[role]) throw new Error('target_role_invalid');
  return true;
}
module.exports = Object.freeze({ TARGET, validate });
