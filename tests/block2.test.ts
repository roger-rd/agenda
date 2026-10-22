import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { santiagoInstant, zonedFormat } from '../src/lib/dates';
import { dateKey, movePeriod, periodDays, periodRange, readPeriod, resolveView } from '../src/lib/periods';
import { can } from '../src/store/permissions';
import { profileIds, emptyFilters, selectCompanies, selectCounts, selectPost, selectViewPosts } from '../src/store/selectors';
import { changePostStatus } from '../src/store/transitions';
import type { Post, Role } from '../src/types';

function fixture() {
  const state = { ...generateDemo(), authenticated: true };
  const base = state.posts[0];
  const post = (id: string, day: string, status: Post['status'], visible = true): Post => ({
    ...base, id, scheduledAt: santiagoInstant(day, '23:30'), status,
    visible_para_cliente: visible, confirmadoEn: undefined, confirmadoPor: undefined,
  });
  state.posts = [
    post('dec', '2025-12-31', 'Pendiente'),
    post('jan', '2026-01-01', 'En proceso'),
    post('hidden', '2026-01-02', 'Pendiente', false),
    post('done', '2026-01-03', 'Completado'),
    post('feb', '2026-02-01', 'Pendiente'),
    { ...post('other', '2026-01-01', 'Pendiente'), companyId: 'company-2' },
  ];
  return state;
}
test('contadores mensuales: empresa, Santiago, estado y visibilidad', () => {
  const state = fixture();
  const now = new Date('2026-02-01T01:00:00Z'); // Aún enero en Santiago.
  assert.deepEqual(selectCounts(state, 'company-0', now), { planned: 3, pending: 2 });
  assert.deepEqual(selectCounts({ ...state, activeUserId: 'roger', role: 'client' }, 'company-0', now), { planned: 2, pending: 1 });
  const worker = { ...state, activeUserId: 'ana', role: 'worker' as const };
  assert.deepEqual(selectCompanies(worker).map(c => c.id), ['company-0', 'company-1']);
  assert.deepEqual(selectCounts(worker, 'company-0', now), { planned: 3, pending: 2 });
  assert.deepEqual(selectCounts(worker, 'company-2', now), { planned: 0, pending: 0 });
  assert.deepEqual(selectCounts({ ...state, activeUserId: 'roger', role: 'client' }, 'company-2', now), { planned: 0, pending: 0 });
  assert.deepEqual(selectCounts(state, 'company-0', new Date(santiagoInstant('2026-02-01', '12:00'))), { planned: 1, pending: 1 });
});
test('cliente: Año, Mes y Semana comparten aislamiento; tablero inaccesible', () => {
  const state = { ...fixture(), activeUserId: 'roger', role: 'client' as const };
  for (const view of ['anio', 'mes', 'semana'] as const) {
    const posts = selectViewPosts(state, 'company-0', emptyFilters, '2026-01-01', view);
    assert.ok(posts.length > 0);
    assert.ok(posts.every(p => p.visible_para_cliente && p.companyId === 'company-0'));
    assert.deepEqual(selectViewPosts(state, 'company-2', emptyFilters, '2026-01-01', view), []);
    assert.ok(selectViewPosts(state, 'company-0', { ...emptyFilters, status: 'Completado' }, '2026-01-01', view).every(p => p.status === 'Completado'));
  }
  assert.deepEqual(selectViewPosts(state, 'company-0', emptyFilters, '2026-01-01', 'tablero'), []);
  assert.equal(selectPost(state, 'hidden'), undefined);
  assert.equal(selectPost(state, 'missing'), undefined);
  assert.equal(resolveView('tablero', 'client'), 'semana');
  assert.equal(resolveView(null, 'client'), 'semana');
  assert.equal(resolveView('anio', 'client'), 'anio');
});
test('changeStatus: permisos, confirmación, limpieza e idempotencia', () => {
  for (const role of ['community_manager', 'worker', 'client'] as Role[]) {
    const state = { ...fixture(), role, activeUserId: profileIds[role] };
    const allowed = role !== 'client';
    assert.equal(can(role, 'changeStatus'), allowed);
    const now = new Date('2026-01-04T16:00:00Z');
    const uploaded = changePostStatus(state, 'jan', 'Subido', now);
    if (!allowed) { assert.equal(uploaded, state); continue; }
    const post = selectPost(uploaded, 'jan')!;
    assert.equal(post.status, 'Subido');
    assert.equal(post.confirmadoPor, role === 'worker' ? 'ana' : 'edison');
    assert.equal(post.confirmadoEn, now.toISOString());
    assert.equal(changePostStatus(uploaded, 'jan', 'Subido'), uploaded);
    const cleared = selectPost(changePostStatus(uploaded, 'jan', 'Pendiente'), 'jan')!;
    assert.equal(cleared.confirmadoPor, undefined);
    assert.equal(cleared.confirmadoEn, undefined);
    for (const view of ['anio', 'mes', 'semana', 'tablero'] as const) {
      assert.equal(selectViewPosts(uploaded, 'company-0', { ...emptyFilters, status: 'Subido' }, '2026-01-01', view)[0]?.id, 'jan');
    }
  }
  const worker = { ...fixture(), activeUserId: 'ana', role: 'worker' as const };
  assert.equal(changePostStatus(worker, 'other', 'Subido'), worker);
  assert.equal(changePostStatus(worker, 'missing', 'Subido'), worker);
  assert.equal(can('worker', 'createCompany'), false);
});
test('semana lunes–domingo cruza mes y año, independientemente del instante UTC', () => {
  const reference = zonedFormat('2026-01-01T01:00:00Z', 'yyyy-MM-dd');
  assert.equal(reference, '2025-12-31');
  const days = periodDays(reference, 'semana').map(dateKey);
  assert.equal(days.length, 7);
  assert.equal(days[0], '2025-12-29');
  assert.equal(days[6], '2026-01-04');
  const range = periodRange('2026-03-01', 'semana');
  assert.equal(dateKey(range.start), '2026-02-23');
  assert.equal(dateKey(range.end), '2026-03-01');
  assert.equal(movePeriod(reference, 'semana', 1), '2026-01-07');
  assert.equal(movePeriod('2026-01-07', 'semana', -1), reference);
});
test('mes/año: bisiesto, navegación, relleno y fechas inválidas', () => {
  assert.equal(periodDays('2024-02-15', 'mes').length, 29);
  assert.equal(periodDays('2024-02-15', 'anio').length, 366);
  assert.equal(periodDays('2026-02-15', 'mes', true).length % 7, 0);
  assert.equal(dateKey(periodRange('2026-07-15', 'anio').start), '2026-01-01');
  assert.equal(dateKey(periodRange('2026-07-15', 'anio').end), '2026-12-31');
  assert.equal(movePeriod('2026-12-31', 'mes', 1), '2027-01-31');
  assert.equal(movePeriod('2026-01-31', 'mes', 1), '2026-02-28');
  assert.equal(movePeriod('2024-02-29', 'anio', 1), '2025-02-28');
  assert.equal(movePeriod('2026-01-15', 'anio', -1), '2025-01-15');
  assert.equal(readPeriod('2026-07-15'), '2026-07-15');
  assert.notEqual(readPeriod('2026-02-31'), '2026-02-31');
  assert.notEqual(readPeriod('invalid'), 'invalid');
});
test('semanas durante cambios de horario conservan siete fechas civiles', () => {
  for (const reference of ['2026-04-05', '2026-09-06']) {
    const days = periodDays(reference, 'semana').map(dateKey);
    assert.equal(new Set(days).size, 7);
    for (const day of days) assert.equal(zonedFormat(santiagoInstant(day, '12:00'), 'yyyy-MM-dd'), day);
  }
});
