import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRecovery, updateRecovery } from '../src/features/access/recovery';
import { recoveryFocusTarget } from '../src/lib/recoveryFocus';

test('evento externo: recuperación del mismo usuario, sin repetir en nuevos renders', () => {
  const blocked = updateRecovery(initialRecovery, 'ana', true);
  const restored = updateRecovery(blocked, 'ana', false);
  assert.equal(restored.restored, true);
  assert.equal(restored.returning, true);
  assert.equal(updateRecovery(restored, 'ana', false), restored);
  assert.deepEqual(restored.blockedUsers, []);
  const other = updateRecovery(restored, 'roger', false);
  assert.equal(updateRecovery(other, 'ana', false).restored, false);
  assert.equal(updateRecovery(updateRecovery(restored, 'ana', true), 'ana', false).restored, true);
});
test('cambio deliberado desde bloqueo: nuevo usuario sin aviso, identidad antes bloqueada con aviso', () => {
  const blocked = updateRecovery(initialRecovery, 'ana', true);
  const other = updateRecovery(blocked, 'roger', false);
  assert.equal(other.restored, false);
  assert.equal(other.returning, true);
  assert.equal(updateRecovery(other, 'ana', false).restored, true);
  const logout = updateRecovery(blocked, null, false);
  assert.deepEqual(logout, initialRecovery);
  assert.equal(updateRecovery(logout, 'ana', false).restored, false);
});
test('prioridad: overlay, aviso de recuperación, main; sin recuperación no se roba foco', () => {
  for (const noticeVisible of [true, false]) {
    assert.equal(recoveryFocusTarget({ pending: true, noticeVisible, overlayOpen: true }), null);
    assert.equal(recoveryFocusTarget({ pending: false, noticeVisible, overlayOpen: false }), null);
  }
  assert.equal(recoveryFocusTarget({ pending: true, noticeVisible: true, overlayOpen: false }), 'notice');
  assert.equal(recoveryFocusTarget({ pending: true, noticeVisible: false, overlayOpen: false }), 'main');
});

test('restauraciones tardías no repiten el foco ni desplazan el anuncio ya enfocado', async () => {
  const { restorePendingWorkspaceFocus } = await import('../src/lib/recoveryFocus');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let focuses = 0, scrolls = 0, overlay = true;
  const documentStub = { activeElement: null as unknown, querySelector: (selector: string): unknown => {
    if (selector === '.drawer-open, dialog[open]') return overlay ? {} : null;
    if (selector === 'main[data-recovery-focus]') return 'recoveryFocus' in main.dataset ? main : null;
    if (selector === 'main[data-recovery-complete]') return 'recoveryComplete' in main.dataset ? main : null;
    return null;
  } };
  const notice = { focus: () => { focuses++; documentStub.activeElement = notice; }, scrollIntoView: () => { scrolls++; } };
  const main = { dataset: { recoveryFocus: '' } as Record<string, string>, querySelector: () => notice };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  try {
    assert.equal(restorePendingWorkspaceFocus(), true); assert.equal(focuses, 0);
    overlay = false;
    assert.equal(restorePendingWorkspaceFocus(), true); assert.equal(focuses, 1); assert.equal(scrolls, 1);
    assert.equal(restorePendingWorkspaceFocus(), true); assert.equal(focuses, 1); assert.equal(scrolls, 1);
    documentStub.activeElement = {};
    assert.equal(restorePendingWorkspaceFocus(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
