import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { acceptAttachments, toInput, validateDraft, type Draft } from '../src/features/posts/validation';
import { addComment, deletePost, savePost, serializeState, setStatus, type Result } from '../src/store/operations';
import { selectComments, selectPost } from '../src/store/selectors';
import type { Attachment, State } from '../src/types';

const draft = (): Draft => ({
  companyId: 'company-0', title: 'Nueva idea', description: '', day: '2026-10-17',
  time: '10:00', format: 'Post', status: 'Pendiente', responsibleId: 'ana',
  visible_para_cliente: false, instagramUrl: '', attachments: [],
});
function next(result: Result): State {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}
const file = (id: string, size = 1024, mimeType = 'image/png'): Attachment => ({
  id, name: `${id}.png`, size, mimeType,
});
test('formulario: título, fecha real, hora, salto horario Santiago, URL y responsable', () => {
  const state = generateDemo();
  assert.deepEqual(validateDraft(draft(), state), {});
  for (const [key, value] of [
    ['title', '  '], ['title', 'a'.repeat(121)], ['day', '2026-02-30'],
    ['day', ''], ['time', '25:00'], ['time', '12:60'], ['time', ''],
    ['instagramUrl', 'javascript:alert(1)'], ['instagramUrl', 'instagram.com/test'],
    ['responsibleId', 'pablo'], ['responsibleId', 'roger'],
  ] as const) assert.ok(validateDraft({ ...draft(), [key]: value }, state)[key]);
  assert.ok(validateDraft({ ...draft(), day: '2026-09-06', time: '00:30' }, state).time);
  assert.deepEqual(validateDraft({ ...draft(), instagramUrl: 'https://instagram.com/p/demo' }, state), {});
});
test('adjuntos: rechazo individual conserva válidos y permite exactamente 5 MB', () => {
  const original = [file('existing')];
  const result = acceptAttachments(original, [file('large', 5 * 1024 * 1024 + 1),
    file('valid', 5 * 1024 * 1024), file('text', 1, 'text/plain'),
    file('third'), file('fourth'), file('overflow')]);
  assert.deepEqual(result.accepted.map(a => a.id), ['existing', 'valid', 'third', 'fourth']);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /5 MB/);
  assert.match(result.errors[1], /no es una imagen/);
  assert.match(result.errors[2], /4 imágenes/);
  assert.equal(original.length, 1);
});
test('persistencia: adjuntos contienen exclusivamente metadatos', () => {
  const state = generateDemo();
  state.posts[0].attachments = [{ ...file('one'), url: 'blob:secret', content: 'base64', blob: {} } as Attachment];
  const serialized = serializeState(state);
  assert.deepEqual(JSON.parse(serialized).posts[0].attachments, [file('one')]);
  assert.equal(serialized.includes('blob:secret'), false);
  assert.equal(serialized.includes('base64'), false);
});
test('store: rechaza rol, empresas no asignadas y responsable ajeno sin mutación', () => {
  for (const role of ['community_manager', 'worker', 'client'] as const) {
    const state = { ...generateDemo(), role };
    const before = JSON.stringify(state);
    const id = state.posts[0].id;
    const input = toInput(draft());
    if (role === 'client') {
      for (const result of [savePost(state, input), savePost(state, input, id),
        deletePost(state, id), setStatus(state, id, 'Subido')]) assert.equal(result.ok, false);
    } else {
      assert.ok(savePost(state, input).ok);
      assert.ok(savePost(state, input, id).ok);
      assert.ok(deletePost(state, id).ok);
      assert.ok(setStatus(state, id, 'Subido').ok);
    }
    assert.equal(savePost(state, { ...input, responsibleId: 'pablo' }).ok, false);
    assert.equal(savePost(state, { ...input, responsibleId: 'roger' }, id).ok, false);
    assert.equal(JSON.stringify(state), before);
  }
  const worker = { ...generateDemo(), role: 'worker' as const };
  const other = worker.posts.find(p => p.companyId === 'company-2')!;
  const input = { ...toInput(draft()), companyId: other.companyId, responsibleId: 'pablo' };
  for (const result of [savePost(worker, input), savePost(worker, input, other.id),
    deletePost(worker, other.id), setStatus(worker, other.id, 'Subido'), addComment(worker, other.id, 'Hola')])
    assert.equal(result.ok, false);
  worker.posts[0].responsibleId = 'pablo';
  assert.equal(setStatus(worker, worker.posts[0].id, 'Subido').ok, false);
  assert.equal(deletePost(worker, worker.posts[0].id).ok, false);
  assert.equal(addComment(worker, worker.posts[0].id, 'Hola').ok, false);
});
test('Subido: formulario, tablero y detalle comparten confirmación, conservación y limpieza', () => {
  for (const source of ['formulario', 'tablero', 'detalle']) {
    let state = generateDemo();
    const id = state.posts[0].id;
    const now = new Date('2026-10-17T16:00:00Z');
    state = next(source === 'formulario'
      ? savePost(state, { ...toInput(draft()), status: 'Subido' }, id, now)
      : setStatus(state, id, 'Subido', now));
    assert.equal(selectPost(state, id)?.confirmadoPor, 'edison');
    assert.equal(selectPost(state, id)?.confirmadoEn, now.toISOString());
    state = next(savePost(state, { ...toInput(draft()), title: 'Editado', status: 'Subido' }, id));
    assert.equal(selectPost(state, id)?.confirmadoEn, now.toISOString());
    state = next(setStatus(state, id, 'Pendiente'));
    assert.equal(selectPost(state, id)?.confirmadoEn, undefined);
    assert.equal(selectPost(state, id)?.confirmadoPor, undefined);
  }
  const created = next(savePost(generateDemo(), { ...toInput(draft()), status: 'Subido' }));
  assert.ok(created.posts.at(-1)?.confirmadoEn);
});
test('comentarios: acceso del cliente, ocultar conserva, eliminar borra y orden cronológico', () => {
  let state = generateDemo();
  const id = state.posts[0].id;
  assert.equal(addComment({ ...state, role: 'client' }, id, 'Oculto').ok, false);
  const other = state.posts.find(p => p.companyId === 'company-1' && p.visible_para_cliente)!;
  assert.equal(addComment({ ...state, role: 'client' }, other.id, 'Otra empresa').ok, false);
  assert.equal(addComment(state, id, ' ').ok, false);
  assert.equal(addComment(state, id, 'a'.repeat(2001)).ok, false);
  state = next(savePost(state, { ...toInput(draft()), visible_para_cliente: true }, id));
  state = next(addComment({ ...state, role: 'client' }, id, 'Cliente', new Date('2026-10-17T16:00:00Z')));
  state = next(addComment({ ...state, role: 'worker' }, id, 'Equipo', new Date('2026-10-17T15:00:00Z')));
  assert.deepEqual(selectComments(state, id).map(c => c.body), ['Equipo', 'Cliente']);
  state = next(savePost(state, toInput(draft()), id));
  assert.equal(selectComments({ ...state, role: 'client' }, id).length, 0);
  assert.equal(addComment({ ...state, role: 'client' }, id, 'No autorizado').ok, false);
  assert.equal(state.comments.filter(c => c.postId === id).length, 2);
  state = next(deletePost(state, id));
  assert.equal(state.comments.filter(c => c.postId === id).length, 0);
  assert.equal(selectPost(state, id), undefined);
});
