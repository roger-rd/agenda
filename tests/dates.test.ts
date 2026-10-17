import { test } from 'node:test';
import assert from 'node:assert/strict';
import { santiagoInstant, zonedFormat } from '../src/lib/dates';
import { generateDemo } from '../src/data/demo';

test('hora de un dígito: acepta 9:30 y conserva la hora local de Santiago', () => {
    assert.equal(santiagoInstant('2026-01-15', '9:30'), '2026-01-15T12:30:00.000Z');
    assert.equal(santiagoInstant('2026-01-15', '09:30'), '2026-01-15T12:30:00.000Z');
});

test('conversión de Santiago respeta los desfases de verano e invierno', () => {
    assert.equal(santiagoInstant('2026-07-15', '09:30'), '2026-07-15T13:30:00.000Z');
    for (const day of ['2026-01-15', '2026-07-15']) {
        assert.equal(zonedFormat(santiagoInstant(day, '18:30'), 'yyyy-MM-dd HH:mm'), `${day} 18:30`);
    }
});

test('la demo genera fechas válidas para todas las publicaciones y confirmaciones', () => {
    const state = generateDemo();
    assert.equal(state.posts.length, 261);
    for (const post of state.posts) {
        assert.ok(Number.isFinite(Date.parse(post.scheduledAt)), post.id);
        if (post.status === 'Subido') {
            assert.ok(post.confirmadoEn);
            assert.ok(Number.isFinite(Date.parse(post.confirmadoEn)), post.id);
        }
    }
});
