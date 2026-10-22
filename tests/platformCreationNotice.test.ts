import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CREATION_INVITATION_NOTICE, createdOrganizationVisibility, type OrganizationRow } from '../src/features/platform/organizationRows';
test('aviso derivado: oculta → visible → oculta tras cambiar filtros y búsqueda', () => {
  const rows: OrganizationRow[] = [{ id: 'new', name: 'Nueva', status: 'active', managers: [], isExample: false }];
  for (const [q, estado, expected] of [['', 'suspendidas', 'hidden'], ['', 'activas', 'visible'], ['otra', 'activas', 'hidden'], ['Nueva', 'todas', 'visible']] as const)
    assert.equal(createdOrganizationVisibility('new', rows, { q, estado }), expected);
  assert.equal(createdOrganizationVisibility(null, rows, { q: '', estado: 'todas' }), null);
  assert.equal(createdOrganizationVisibility('new', [], { q: '', estado: 'todas' }), 'hidden');
});

test('invitación simulada visible una sola vez, sin copia solo para lectores', () => {
  assert.match(CREATION_INVITATION_NOTICE, /^Invitación simulada:/);
  assert.match(CREATION_INVITATION_NOTICE, /no se envió ningún correo/);
  assert.match(CREATION_INVITATION_NOTICE, /ni se creó un espacio de trabajo funcional/);
  const source = readFileSync(new URL('../src/features/platform/Organizations.tsx', import.meta.url), 'utf8');
  const notice = source.slice(source.indexOf('{success &&'), source.indexOf('{warning &&'));
  assert.match(notice, /<p className="creation-invitation">\{CREATION_INVITATION_NOTICE\}<\/p>/);
  assert.equal(notice.split('{CREATION_INVITATION_NOTICE}').length - 1, 1);
  assert.doesNotMatch(notice, /visually-hidden|sr-only|aria-hidden/);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.organization-success \.creation-invitation\s*\{[^}]*line-clamp: 2;[^}]*white-space: normal;/);
});
