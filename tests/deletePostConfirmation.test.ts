import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeletePostConfirmation } from '../src/features/posts/deletePostConfirmation';

test('eliminar: incluye el título normal entre comillas angulares', () => {
  assert.equal(formatDeletePostConfirmation('Campaña de verano'),
    'Se eliminará «Campaña de verano» y todos sus comentarios. Esta acción no se puede deshacer.');
});
test('eliminar: conserva comillas y caracteres HTML como texto', () => {
  const title = 'Campaña «Especial» "verano" <b>nuevo</b>';
  assert.equal(formatDeletePostConfirmation(title),
    `Se eliminará «${title}» y todos sus comentarios. Esta acción no se puede deshacer.`);
});
test('eliminar: conserva completo un título largo sin espacios', () => {
  const title = 'Publicación'.repeat(100);
  assert.equal(formatDeletePostConfirmation(title),
    `Se eliminará «${title}» y todos sus comentarios. Esta acción no se puede deshacer.`);
});
test('eliminar: título vacío o solo espacios tiene una alternativa legible', () => {
  for (const title of ['', '   ', '\n\t']) {
    assert.equal(formatDeletePostConfirmation(title),
      'Se eliminará «Publicación sin título» y todos sus comentarios. Esta acción no se puede deshacer.');
  }
});
