import { ConstraintEntry, ConstraintRegistry } from './constraint-registry';
const unique = { kind: 'unique', name: 'uq_email', code: 'email_conflict', field: 'email', message: 'Dato duplicado.' } as const;
it('registro vacío, búsquedas tipadas y entradas congeladas', () => {
  const r = new ConstraintRegistry(); expect(r.size).toBe(0);
  expect(r.unique('unknown')).toBeUndefined(); expect(r.check('unknown')).toBeUndefined(); expect(r.foreignKey('unknown')).toBeUndefined(); expect(r.notNull('t', 'x')).toBeUndefined();
  r.register(unique); expect(r.unique('uq_email')).toEqual(unique); expect(Object.isFrozen(r.unique('uq_email'))).toBe(true); expect(r.check('uq_email')).toBeUndefined();
  r.register({ kind: 'foreign_key', name: 'fk_parent', childTable: 'child', parentTable: 'parent' }); expect(r.foreignKey('fk_parent')?.referenceIn).toBe('body');
  r.register({ kind: 'not_null', table: 'child', column: 'title', origin: 'input', code: 'required', message: 'Obligatorio.' }); expect(r.notNull('child', 'title')?.origin).toBe('input');
});
it.each([
  { name: 'bad' }, { name: 'fk_wrong' }, { name: 'uq_\n' }, { name: 'uq_' + 'a'.repeat(60) }, { code: 'A' }, { code: 'x' }, { code: 'valid\n' }, { field: 'bad.field' }, { field: 'a'.repeat(42) }, { message: 'a'.repeat(201) }, { message: 'a\nb' }, { kind: 'CANARIO_KIND' },
])('rechaza entrada inválida %#', patch => expect(() => new ConstraintRegistry().register({ ...unique, ...patch } as ConstraintEntry)).toThrow('Registro de restricción inválido.'));
it.each([
  { kind: 'check', name: 'uq_wrong', origin: 'input', code: 'valid', message: 'Seguro.' },
  { kind: 'check', name: 'ck_valid', origin: 'bad', code: 'valid', message: 'Seguro.' },
  { kind: 'not_null', table: 'bad-table', column: 'id', origin: 'input', code: 'valid', message: 'Seguro.' },
  { kind: 'not_null', table: 'table', column: 'Bad', origin: 'input', code: 'valid', message: 'Seguro.' },
  ...[{ referenceIn: 'bad' }, { tenantBoundary: 1 }, { restrictCode: 'Bad' }, { writeMessage: 'a\nb' }, { childTable: 'Bad' }, { parentTable: 'Bad' }].map(p => ({ kind: 'foreign_key', name: 'fk_valid', childTable: 'child', parentTable: 'parent', ...p })),
])('validación específica %#', entry => expect(() => new ConstraintRegistry().register(entry as ConstraintEntry)).toThrow('Registro de restricción inválido.'));
it('rechaza duplicados y limita a 500 entradas', () => {
  const r = new ConstraintRegistry(); r.register(unique); expect(() => r.register(unique)).toThrow();
  for (let i = 1; i < 500; i++) r.register({ ...unique, name: `uq_${i}` });
  expect(r.size).toBe(500); expect(() => r.register({ ...unique, name: 'uq_extra' })).toThrow();
});
