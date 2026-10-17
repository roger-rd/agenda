import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralize } from '../src/lib/pluralize';
for (const count of [0, 1, 2]) {
  test(`pluralización para ${count}`, () => {
    assert.equal(pluralize(count, 'publicación', 'publicaciones'), `${count} ${count === 1 ? 'publicación' : 'publicaciones'}`);
    assert.equal(pluralize(count, 'tarea pendiente', 'tareas pendientes'), `${count} ${count === 1 ? 'tarea pendiente' : 'tareas pendientes'}`);
    assert.equal(pluralize(count, 'empresa'), `${count} ${count === 1 ? 'empresa' : 'empresas'}`);
  });
}
