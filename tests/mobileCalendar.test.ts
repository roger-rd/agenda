import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount, compactWeekLabel, dailyCounts, indicatorLabel, monthCells, selectedPeriodDay } from '../src/features/calendar/compactCalendar';
import { dateKey, movePeriod, periodLabel } from '../src/lib/periods';
import { santiagoInstant } from '../src/lib/dates';
import { pluralize } from '../src/lib/pluralize';
import { generateDemo } from '../src/data/demo';
import { emptyFilters, selectFilteredPosts } from '../src/store/selectors';

test('Mes: día válido, hoy, primero del mes y parámetros inválidos o fuera del periodo', () => {
  const select = (day: string | null, today = '2026-10-17') => selectedPeriodDay('2026-10-12', 'mes', day, today);
  assert.equal(select('2026-10-03'), '2026-10-03');
  for (const day of [null, '', 'incorrecto', '2026-02-30', '2026-10-32', '2026-09-30', '2027-10-03']) {
    assert.equal(select(day), '2026-10-17');
    assert.equal(select(day, '2026-11-01'), '2026-10-01');
  }
  assert.equal(selectedPeriodDay('2024-02-01', 'mes', '2024-02-29', '2026-10-17'), '2024-02-29');
});
test('Semana: lunes por defecto, hoy y selección al cruzar mes y año', () => {
  assert.equal(selectedPeriodDay('2026-01-01', 'semana', null, '2026-10-17'), '2025-12-29');
  assert.equal(selectedPeriodDay('2026-01-01', 'semana', null, '2026-01-04'), '2026-01-04');
  assert.equal(selectedPeriodDay('2026-01-01', 'semana', '2025-12-31', '2026-01-04'), '2025-12-31');
  for (const day of ['2026-01-05', '2025-12-28', '2025-12-32', 'x', null])
    assert.equal(selectedPeriodDay('2026-01-01', 'semana', day, '2026-10-17'), '2025-12-29');
  assert.equal(selectedPeriodDay('2026-03-01', 'semana', '2026-02-28'), '2026-02-28');
});
test('celdas: lunes primero, semanas completas, cinco o seis filas y bisiestos', () => {
  for (const year of [2021, 2024, 2026, 2027]) for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const cells = monthCells(`${key}-01`);
    assert.equal(cells[0].getDay(), 1);
    assert.equal(cells.at(-1)!.getDay(), 0);
    assert.ok(cells.length === 35 || cells.length === 42);
    assert.equal(new Set(cells.map(dateKey)).size, cells.length);
    assert.ok(cells.some(day => dateKey(day) === `${key}-01`));
  }
  assert.equal(monthCells('2021-02-01').length, 35);
  assert.equal(monthCells('2026-03-01').length, 42);
  assert.ok(monthCells('2024-02-01').some(day => dateKey(day) === '2024-02-29'));
});
test('indicadores autorizados: cliente excluye ocultas y otra empresa; filtros en vivo', () => {
  const state = generateDemo();
  const base = { ...state.posts[0], companyId: 'company-0', scheduledAt: santiagoInstant('2026-10-14', '23:30'), status: 'Pendiente' as const };
  state.posts = [
    { ...base, id: 'visible', visible_para_cliente: true },
    { ...base, id: 'oculta', visible_para_cliente: false },
    { ...base, id: 'otra', companyId: 'company-2', visible_para_cliente: true },
  ];
  assert.equal(dailyCounts(selectFilteredPosts(state, 'company-0', emptyFilters)).get('2026-10-14'), 2);
  state.role = 'client'; state.activeUserId = 'roger';
  assert.equal(dailyCounts(selectFilteredPosts(state, 'company-0', emptyFilters)).get('2026-10-14'), 1);
  assert.equal(dailyCounts(selectFilteredPosts(state, 'company-2', emptyFilters)).size, 0);
  assert.equal(dailyCounts(selectFilteredPosts(state, 'company-0', { ...emptyFilters, status: 'Subido' })).size, 0);
});
test('filtros activos, contador compacto y pluralización de agenda y hoja', () => {
  assert.equal(activeFilterCount(emptyFilters), 0);
  assert.equal(activeFilterCount({ ...emptyFilters, status: 'Pendiente' }), 1);
  assert.equal(activeFilterCount({ ...emptyFilters, format: 'Reel', responsible: 'ana' }), 2);
  assert.equal(activeFilterCount({ status: 'Subido', format: 'Post', responsible: 'ana' }), 3);
  for (const count of [1, 3, 9]) assert.equal(indicatorLabel(count), String(count));
  for (const count of [10, 99]) assert.equal(indicatorLabel(count), '9+');
  for (const [count, expected] of [[0, '0 publicaciones'], [1, '1 publicación'], [12, '12 publicaciones']] as const) {
    assert.equal(pluralize(count, 'publicación', 'publicaciones'), expected);
    assert.equal(`Ver ${pluralize(count, 'publicación', 'publicaciones')}`, `Ver ${expected}`);
  }
});
test('etiquetas y navegación por mes y semana mantienen fechas civiles', () => {
  assert.equal(compactWeekLabel('2026-10-15'), '12 oct – 18 oct 2026');
  assert.equal(compactWeekLabel('2026-01-01'), '29 dic 2025 – 4 ene 2026');
  assert.equal(compactWeekLabel('2026-03-01'), '23 feb – 1 mar 2026');
  assert.equal(periodLabel('2026-10-01', 'mes'), 'octubre 2026');
  assert.equal(movePeriod('2026-12-31', 'mes', 1), '2027-01-31');
  assert.equal(movePeriod('2026-01-31', 'mes', -1), '2025-12-31');
  assert.equal(movePeriod('2026-01-31', 'mes', 1), '2026-02-28');
  assert.equal(selectedPeriodDay(movePeriod('2026-12-31', 'mes', 1), 'mes', null, '2026-10-17'), '2027-01-01');
});
