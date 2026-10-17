import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { santiagoInstant } from '../src/lib/dates';
import { emptyFilters, selectPost, selectViewPosts } from '../src/store/selectors';

test('store: cambio único sincroniza Año/Mes/Semana/Tablero/detalle y confirmaciones', async () => {
  const fixture = generateDemo();
  fixture.posts = [{ ...fixture.posts[0], id: 'sync', scheduledAt: santiagoInstant('2026-01-15', '12:00'), status: 'Pendiente' }];
  const storage = new Map([['agenda-demo-v2', JSON.stringify(fixture)]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  try {
    const { actions, getState } = await import('../src/store/index');
    for (const status of ['Subido', 'En proceso', 'Subido', 'Completado'] as const) {
      actions.changeStatus('sync', status);
      const state = getState();
      const detail = selectPost(state, 'sync')!;
      assert.equal(detail.status, status);
      for (const view of ['anio', 'mes', 'semana', 'tablero'] as const) {
        assert.strictEqual(selectViewPosts(state, 'company-0', emptyFilters, '2026-01-15', view)[0], detail);
        assert.strictEqual(selectViewPosts(state, 'company-0', { ...emptyFilters, status }, '2026-01-15', view)[0], detail);
      }
      if (status === 'Subido') {
        assert.equal(detail.confirmadoPor, 'edison');
        assert.ok(Number.isFinite(Date.parse(detail.confirmadoEn!)));
        actions.changeStatus('sync', 'Subido');
        assert.strictEqual(getState(), state);
      } else {
        assert.equal(detail.confirmadoPor, undefined);
        assert.equal(detail.confirmadoEn, undefined);
      }
      assert.deepEqual(JSON.parse(storage.get('agenda-demo-v2')!).posts[0], detail);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('acciones públicas: CRUD, rechazos sin mutar, comentarios, metadatos y restablecer', async () => {
  const { actions, getState } = await import('../src/store/index');
  actions.setRole('community_manager');
  const input = {
    companyId: 'company-0', title: 'Prueba CRUD', description: '',
    scheduledAt: santiagoInstant('2026-10-17', '10:00'),
    format: 'Post' as const, status: 'Pendiente' as const, responsibleId: 'ana',
    visible_para_cliente: false, attachments: [],
  };
  assert.ok(actions.createPost(input).ok);
  const id = getState().posts.at(-1)!.id;
  assert.equal(getState().posts.at(-1)?.visible_para_cliente, false);
  assert.ok(actions.addComment(id, 'Comentario de equipo').ok);
  actions.setRole('client');
  const snapshot = getState();
  for (const result of [actions.createPost(input), actions.updatePost(id, input),
    actions.deletePost(id), actions.changeStatus(id, 'Subido'), actions.addComment(id, 'No visible')]) {
    assert.equal(result.ok, false);
    assert.strictEqual(getState(), snapshot);
  }
  actions.setRole('worker');
  assert.equal(actions.createPost({ ...input, companyId: 'company-2' }).ok, false);
  assert.equal(actions.updatePost(id, { ...input, responsibleId: 'pablo' }).ok, false);
  assert.ok(actions.updatePost(id, { ...input, visible_para_cliente: true, status: 'Subido' }).ok);
  const confirmation = getState().posts.find(p => p.id === id)!.confirmadoEn;
  assert.ok(actions.updatePost(id, { ...input, visible_para_cliente: true, status: 'Subido', title: 'Editado' }).ok);
  assert.equal(getState().posts.find(p => p.id === id)!.confirmadoEn, confirmation);
  actions.setRole('client');
  assert.ok(actions.addComment(id, 'Comentario del cliente').ok);
  actions.setRole('worker');
  assert.ok(actions.deletePost(id).ok);
  assert.equal(getState().comments.some(c => c.postId === id), false);
  actions.setRole('community_manager');
  actions.reset();
  assert.equal(getState().version, 2);
  assert.equal(getState().posts.length, 261);
  assert.equal(getState().comments.length, 2);
});
