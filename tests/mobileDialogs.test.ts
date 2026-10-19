import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogViewport } from '../src/lib/dialogViewport';
import { needsAgendaScroll, scrollBehavior } from '../src/lib/scroll';

test('diálogo: inset considera desplazamiento visual y nunca resulta negativo', () => {
  assert.deepEqual(dialogViewport(800), { height: 800, offsetTop: 0, keyboardInset: 0, staticFooter: false });
  assert.deepEqual(dialogViewport(800, { height: 360, offsetTop: 40 }), { height: 360, offsetTop: 40, keyboardInset: 400, staticFooter: true });
  assert.equal(dialogViewport(800, { height: 900, offsetTop: 0 }).keyboardInset, 0);
  assert.equal(dialogViewport(800, { height: 500, offsetTop: 350 }).keyboardInset, 0);
});
test('pie estático solo por debajo de 420 px visibles, también al rotar sin teclado', () => {
  for (const height of [0, 320, 419]) assert.equal(dialogViewport(height).staticFooter, true);
  for (const height of [420, 640, 900]) assert.equal(dialogViewport(900, { height, offsetTop: 0 }).staticFooter, false);
});
test('agenda: encabezado e inicio de tarjeta o vacío visibles antes de omitir scroll', () => {
  assert.equal(needsAgendaScroll({ top: 100, bottom: 180 }, 600, 64, 200), false);
  assert.equal(needsAgendaScroll({ top: 550, bottom: 620 }, 600, 64, 200), true);
  assert.equal(needsAgendaScroll({ top: 800, bottom: 880 }, 600, 64, 200), true);
  assert.equal(needsAgendaScroll({ top: 0, bottom: 80 }, 600, 64, 200), true);
  assert.equal(needsAgendaScroll({ top: 520, bottom: 600 }, 600, 64, 40), false);
  assert.equal(needsAgendaScroll({ top: 560, bottom: 640 }, 600, 64, 40), true);
  assert.equal(needsAgendaScroll({ top: 64, bottom: 180 }, 100, 64, 200), true);
  assert.equal(scrollBehavior(true), 'auto');
  assert.equal(scrollBehavior(false), 'smooth');
});
