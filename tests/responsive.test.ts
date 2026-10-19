import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREAKPOINTS, DESKTOP_QUERY, viewportMode, trappedFocusIndex } from '../src/lib/responsive';

test('límites responsive: móvil, tablet y escritorio', () => {
  assert.deepEqual(BREAKPOINTS, { tablet: 640, desktop: 1024 });
  assert.equal(DESKTOP_QUERY, '(min-width: 1024px)');
  for (const [width, expected] of [[375, 'mobile'], [390, 'mobile'], [639, 'mobile'],
    [640, 'tablet'], [760, 'tablet'], [1023, 'tablet'], [1024, 'desktop'],
    [1100, 'desktop'], [1280, 'desktop'], [1440, 'desktop']] as const) {
    assert.equal(viewportMode(width), expected);
  }
});

test('trampa de foco: extremos, foco externo, un control y navegación interior', () => {
  assert.equal(trappedFocusIndex(0, 4, true), 3);
  assert.equal(trappedFocusIndex(3, 4, false), 0);
  assert.equal(trappedFocusIndex(1, 4, false), null);
  assert.equal(trappedFocusIndex(2, 4, true), null);
  assert.equal(trappedFocusIndex(-1, 4, false), 0);
  assert.equal(trappedFocusIndex(-1, 4, true), 3);
  assert.equal(trappedFocusIndex(0, 1, true), 0);
  assert.equal(trappedFocusIndex(0, 1, false), 0);
  assert.equal(trappedFocusIndex(-1, 0, false), null);
});

test('drawer: escritorio cancela apertura y volver a móvil no reabre el menú', async () => {
  const { resolveDrawerOpen } = await import('../src/lib/responsive');
  assert.equal(resolveDrawerOpen(false, false), false);
  assert.equal(resolveDrawerOpen(true, false), true);
  assert.equal(resolveDrawerOpen(true, true), false);
  assert.equal(resolveDrawerOpen(false, true), false);
  let open = resolveDrawerOpen(true, false);
  for (const width of [1024, 1280, 1440, 768, 390]) {
    open = resolveDrawerOpen(open, viewportMode(width) === 'desktop');
    assert.equal(open, false);
  }
});
