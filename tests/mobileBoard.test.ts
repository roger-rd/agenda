import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayCountLabel, santiagoInstant } from '../src/lib/dates';
import { needsAgendaScroll, scrollBehavior } from '../src/lib/scroll';
import { viewportMode } from '../src/lib/responsive';
import { statusAnnouncement, statusPresentation } from '../src/features/board/boardPresentation';
import { generateDemo } from '../src/data/demo';
import { emptyFilters, selectViewPosts } from '../src/store/selectors';
import { statuses } from '../src/store/transitions';

test('etiquetas legibles: singular, plural, Hoy y cruces de mes/año', () => {
  for (const [count, text] of [[0, '0 publicaciones'], [1, '1 publicación'], [2, '2 publicaciones']] as const)
    assert.equal(dayCountLabel('2026-10-01', count), `1 de octubre de 2026, ${text}`);
  assert.equal(dayCountLabel('2026-10-01', 1, true, true), 'jueves 1 de octubre de 2026, 1 publicación, Hoy');
  assert.equal(dayCountLabel('2026-12-31', 0), '31 de diciembre de 2026, 0 publicaciones');
  assert.equal(dayCountLabel('2027-01-01', 2), '1 de enero de 2027, 2 publicaciones');
  assert.equal(dayCountLabel('2024-02-29', 1), '29 de febrero de 2024, 1 publicación');
  assert.equal(dayCountLabel('2024-03-01', 1), '1 de marzo de 2024, 1 publicación');
});
test('agenda: solo desplazar si el encabezado no está completamente visible', () => {
  assert.equal(needsAgendaScroll({ top: 0, bottom: 800 }, 800), false);
  assert.equal(needsAgendaScroll({ top: 100, bottom: 200 }, 800), false);
  assert.equal(needsAgendaScroll({ top: -1, bottom: 200 }, 800), true);
  assert.equal(needsAgendaScroll({ top: 700, bottom: 801 }, 800), true);
  assert.equal(needsAgendaScroll({ top: 900, bottom: 1000 }, 800), true);
  assert.equal(needsAgendaScroll({ top: 80, bottom: 500 }, 420, 80), false);
  assert.equal(needsAgendaScroll({ top: 79, bottom: 500 }, 420, 80), true);
  assert.equal(scrollBehavior(true), 'auto');
  assert.equal(scrollBehavior(false), 'smooth');
});
test('estado: hoja bajo 1024, menú de escritorio y anuncio explícito', () => {
  for (const width of [320, 390, 639, 640, 768, 1023]) assert.equal(statusPresentation(viewportMode(width)), 'sheet');
  for (const width of [1024, 1280, 1440]) assert.equal(statusPresentation(viewportMode(width)), 'menu');
  for (const status of statuses) assert.equal(statusAnnouncement('Título completo', status), `«Título completo» ahora está en ${status}`);
});
test('tablero: columnas ordenadas, conteos y filtros combinados desde el único selector', () => {
  const state = generateDemo();
  const base = { ...state.posts[0], companyId: 'company-0', responsibleId: 'ana', format: 'Reel' as const };
  state.posts = [
    { ...base, id: 'tarde', status: 'Pendiente', scheduledAt: santiagoInstant('2026-10-15', '14:00') },
    { ...base, id: 'completo', status: 'Completado', scheduledAt: santiagoInstant('2026-10-15', '10:00') },
    { ...base, id: 'temprano', status: 'Pendiente', scheduledAt: santiagoInstant('2026-10-15', '09:00') },
    { ...base, id: 'otro', status: 'Pendiente', format: 'Post', scheduledAt: santiagoInstant('2026-10-15', '08:00') },
  ];
  const filtered = selectViewPosts(state, 'company-0', { ...emptyFilters, format: 'Reel', responsible: 'ana' }, '2026-10-01', 'tablero');
  const columns = statuses.map(status => filtered.filter(post => post.status === status));
  assert.deepEqual(columns.map(column => column.length), [2, 0, 1, 0]);
  assert.deepEqual(columns[0].map(post => post.id), ['temprano', 'tarde']);
  assert.deepEqual(selectViewPosts(state, 'company-0', { status: 'Completado', format: 'Reel', responsible: 'ana' }, '2026-10-01', 'tablero').map(post => post.id), ['completo']);
});
