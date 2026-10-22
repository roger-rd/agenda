import './workspaceStorage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { validateDraft, validateField, removeAttachment, acceptAttachments, toInput, type Draft } from '../src/features/posts/validation';
import { mountAttachmentPreview } from '../src/features/posts/attachmentFiles';
import { emptyFilters, selectRequestedPost, selectCompany, selectViewPosts, selectCounts } from '../src/store/selectors';
import { resolveView, readPeriod } from '../src/lib/periods';
import { todayKey } from '../src/lib/dates';
import type { PostStatus } from '../src/types';
const draft = (): Draft => ({ companyId: 'company-0', title: 'Idea', description: 'Conservar', day: '2026-10-17', time: '10:00', format: 'Post', status: 'Pendiente', responsibleId: 'ana', visible_para_cliente: true, instagramUrl: '', attachments: [] });

test('validación por campo conserva otros errores y limpia fecha/hora dependientes', () => {
  const state = generateDemo();
  let value = { ...draft(), title: '', day: '', time: '', responsibleId: '', instagramUrl: 'incorrecta' };
  let errors = validateDraft(value, state);
  for (const key of ['title', 'day', 'time', 'responsibleId', 'instagramUrl'] as const) {
    value = { ...value, [key]: draft()[key] };
    errors = validateField(value, state, key, errors);
    assert.equal(errors[key], undefined);
    assert.deepEqual(errors, validateDraft(value, state));
  }
  assert.deepEqual(errors, {});
  const gap = { ...draft(), day: '2026-09-06', time: '00:30' };
  assert.ok(validateDraft(gap, state).time);
  assert.deepEqual(validateField({ ...gap, day: '2026-09-07' }, state, 'day', validateDraft(gap, state)), {});
});

test('adjuntos: quitar conserva todos los campos, límite incluye existentes y URL se revoca', () => {
  const file = (id: string) => ({ id, name: id + '.png', mimeType: 'image/png', size: 10 });
  const original = { ...draft(), attachments: [file('a'), file('b')] };
  assert.deepEqual(removeAttachment(original, 'a'), { ...original, attachments: [file('b')] });
  assert.equal(original.attachments.length, 2);
  const result = acceptAttachments(original.attachments, [{ ...file('bad'), mimeType: 'text/plain' }, file('c'), file('d'), file('e')]);
  assert.deepEqual(result.accepted.map(a => a.id), ['a', 'b', 'c', 'd']);
  assert.equal(result.errors.length, 2);
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = url => { revoked.push(url); };
  try {
    const image = { src: '' } as HTMLImageElement;
    const cleanup = mountAttachmentPreview(image, new File(['image'], 'a.png', { type: 'image/png' }));
    assert.equal(image.src, 'blob:preview');
    cleanup();
    assert.deepEqual(revoked, ['blob:preview']);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});

test('URL: tres roles, empresa inexistente/ajena, publicación oculta/ajena y parámetros inválidos', () => {
  for (const role of ['community_manager', 'worker', 'client'] as const) {
    const s = { ...generateDemo(), role, activeUserId: { community_manager: 'edison', worker: 'ana', client: 'roger' }[role] };
    assert.equal(selectCompany(s, 'missing'), undefined);
    assert.equal(selectRequestedPost(s, 'company-0', 'missing'), undefined);
    assert.equal(selectRequestedPost(s, 'company-1', s.posts[0].id), undefined);
    assert.equal(resolveView('invalid', role), role === 'client' ? 'semana' : 'mes');
    assert.equal(resolveView('tablero', role), role === 'client' ? 'semana' : 'tablero');
    if (role !== 'community_manager') assert.equal(selectCompany(s, 'company-2'), undefined);
    if (role === 'client') assert.equal(selectRequestedPost(s, 'company-0', s.posts[0].id), undefined);
  }
  for (const invalid of [null, '', 'invalid', '2026-02-30']) assert.equal(readPeriod(invalid), todayKey());
});

test('acciones públicas deniegan operaciones sin mutar y devuelven error controlado', async () => {
  const { actions, getState } = await import('../src/store');
  actions.login(); actions.setRole('community_manager'); actions.reset();
  const input = toInput(draft());
  const own = getState().posts[0];
  const other = getState().posts.find(p => p.companyId === 'company-2')!;
  function denied(operation: () => unknown) {
    const before = getState();
    const snapshot = JSON.stringify(before);
    const result = operation() as { ok: boolean; reason: string };
    assert.equal(result.ok, false); assert.ok(result.reason);
    assert.strictEqual(getState(), before); assert.equal(JSON.stringify(getState()), snapshot);
  }
  actions.setRole('client');
  for (const operation of [() => actions.createPost(input), () => actions.updatePost(own.id, input),
    () => actions.deletePost(own.id), () => actions.changeStatus(own.id, 'Subido'),
    () => actions.addComment(own.id, 'Oculta'), () => actions.addComment(other.id, 'Ajena'),
    () => actions.createCompany('No autorizada', '#fff')]) denied(operation);
  actions.setRole('worker');
  for (const operation of [() => actions.createPost({ ...input, companyId: other.companyId }),
    () => actions.updatePost(other.id, { ...other }), () => actions.deletePost(other.id),
    () => actions.changeStatus(other.id, 'Subido'), () => actions.addComment(other.id, 'Ajena'),
    () => actions.createCompany('No autorizada', '#fff')]) denied(operation);
  for (const role of ['worker', 'community_manager'] as const) {
    actions.setRole(role);
    denied(() => actions.createPost({ ...input, responsibleId: 'roger' }));
    denied(() => actions.updatePost(own.id, { ...input, responsibleId: 'pablo' }));
    denied(() => actions.createPost({ ...input, companyId: 'missing' }));
    denied(() => actions.deletePost('missing'));
    denied(() => actions.changeStatus(own.id, 'inválido' as PostStatus));
  }
});

test('CRUD con filtros activos sincroniza vistas y contadores sin mutar filtros ni periodo', async () => {
  const { actions, getState } = await import('../src/store');
  actions.login(); actions.setRole('community_manager'); actions.reset();
  const reference = '2040-10-17';
  const filters = Object.freeze({ ...emptyFilters, status: 'Pendiente' as const, responsible: 'ana', format: 'Post' as const });
  const input = toInput({ ...draft(), day: reference });
  const counts = () => selectCounts(getState(), 'company-0', new Date('2040-10-17T15:00:00Z'));
  function views(expected: number) {
    for (const view of ['anio', 'mes', 'semana', 'tablero'] as const)
      assert.equal(selectViewPosts(getState(), 'company-0', filters, reference, view).length, expected);
  }
  assert.ok(actions.createPost(input).ok);
  const id = getState().posts.at(-1)!.id;
  views(1); assert.deepEqual(counts(), { planned: 1, pending: 1 });
  for (const changed of [{ format: 'Reel' as const }, { responsibleId: 'edison' }, { status: 'Completado' as const }]) {
    assert.ok(actions.updatePost(id, { ...input, ...changed }).ok); views(0);
    assert.ok(actions.updatePost(id, input).ok); views(1);
  }
  assert.ok(actions.changeStatus(id, 'Subido').ok); views(0);
  assert.deepEqual(counts(), { planned: 1, pending: 0 });
  assert.ok(actions.deletePost(id).ok); views(0);
  assert.deepEqual(counts(), { planned: 0, pending: 0 });
  assert.deepEqual(filters, { status: 'Pendiente', responsible: 'ana', format: 'Post' });
  assert.equal(reference, '2040-10-17');
});
