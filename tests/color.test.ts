import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHexColor, normalizeHex, contrastRatio, readableTextColor } from '../src/lib/color';

test('hexadecimal estricto, normalización y entradas inválidas', () => {
  for (const value of ['#fff', '#12345', 'red', '#GGGGGG', ' #123456', '#123456 ', '#123456\n', null, undefined, 123456, {}, []])
    assert.equal(isHexColor(value), false, String(value));
  assert.equal(isHexColor('#AbC123'), true);
  assert.equal(normalizeHex('#AbC123'), '#abc123');
  assert.throws(() => contrastRatio('red', '#ffffff'), TypeError);
});
test('WCAG: ratios conocidos, simetría y elección del mayor contraste', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.478089) < 0.00001);
  for (const hex of ['#000000', '#ffffff', '#ffff00', '#000080', '#777777', '#888888', '#abcdef']) {
    const selected = readableTextColor(hex);
    const other = selected === '#ffffff' ? '#111111' : '#ffffff';
    assert.ok(contrastRatio(hex, selected) >= contrastRatio(hex, other));
    assert.equal(contrastRatio(hex, selected), contrastRatio(selected, hex));
  }
  assert.equal(readableTextColor('#000000'), '#ffffff');
  assert.equal(readableTextColor('#ffffff'), '#111111');
  assert.equal(readableTextColor('#ffff00'), '#111111');
  assert.equal(readableTextColor('#000080'), '#ffffff');
});
