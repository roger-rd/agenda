import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generatePlatformSeed } from '../src/platform/seed';
import { generateDemo } from '../src/data/demo';
import { listOrganizations } from '../src/platform/operations';
import { PLATFORM_ADMIN_ID, LINKED_ORGANIZATION_ID } from '../src/platform/ids';
import { createPlatformStore, PLATFORM_KEY } from '../src/platform/store';
import { normalized, validateOrganizationField, validateOrganization, organizationResultError } from '../src/platform/validation';
import { organizationRows, organizationResults, matchesOrganization, parseOrganizationQuery, organizationQueryString } from '../src/features/platform/organizationRows';
import type { AdminSession, ErrorCode } from '../src/platform/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
const input = { name: 'Nueva organización', managerName: 'María Lagos', email: 'maria@ejemplo.cl' };
function fixture() {
  const state = generatePlatformSeed(), workspace = generateDemo();
  const result = listOrganizations(state, admin, workspace); assert.ok(result.ok);
  return { state, workspace, rows: organizationRows(result.value, state, workspace) };
}
test('filas ordenadas, directorio vinculado sin correo inventado y etiquetas', () => {
  const { rows, state, workspace } = fixture();
  assert.deepEqual(rows.map(row => row.name), [...rows.map(row => row.name)].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' })));
  const linked = rows.find(row => row.id === LINKED_ORGANIZATION_ID)!;
  assert.equal(linked.name, workspace.organization.name);
  assert.equal(linked.managers[0].email, null);
  assert.equal(linked.managers[0].name, workspace.users.find(user => user.role === 'community_manager')!.name);
  assert.ok(rows.filter(row => row.id !== linked.id).every(row => row.isExample));
  state.members[0].invitation = { simulated: true, createdAt: '2026-10-20' };
  assert.equal(organizationRows(state.organizations, state, workspace).find(row => row.id === state.members[0].organizationId)!.managers[0].invitationSimulated, true);
  const source = readFileSync(new URL('../src/features/platform/Organizations.tsx', import.meta.url), 'utf8');
  for (const text of ['Sin correo registrado', 'Datos de ejemplo', 'Invitación simulada']) assert.ok(source.includes(text));
});
test('búsqueda normalizada en organización y cualquiera de varios responsables/correos; contadores coherentes', () => {
  const { rows } = fixture();
  rows[0].managers.push({ name: 'Ángela   Pérez', email: 'OTRO@EJEMPLO.CL', example: false, invitationSimulated: true });
  assert.equal(normalized('  ÁNGELA   Pérez  '), 'angela perez');
  for (const q of ['  ANGELA  PÉREZ ', 'otro@ejemplo', 'BRÚMA']) {
    for (const estado of ['todas', 'activas', 'suspendidas'] as const) {
      const result = organizationResults(rows, { q, estado });
      assert.equal(result.counts.todas, result.counts.activas + result.counts.suspendidas);
      assert.equal(result.rows.length, result.counts[estado]);
      assert.equal(result.counts.todas, 1);
    }
  }
  assert.equal(organizationResults(rows, { q: 'inexistente', estado: 'todas' }).rows.length, 0);
});
test('URL se sanea y conserva búsquedas con espacios, acentos y caracteres reservados', () => {
  assert.deepEqual(parseOrganizationQuery('?q=++Ángela+++Pérez++&estado=no'), { q: 'Ángela Pérez', estado: 'todas' });
  assert.deepEqual(parseOrganizationQuery('?q=+++&estado=ACTIVAS'), { q: '', estado: 'todas' });
  for (const estado of ['todas', 'activas', 'suspendidas'] as const) {
    const query = { q: 'Ángela & Socios +', estado };
    assert.deepEqual(parseOrganizationQuery(organizationQueryString(query)), query);
  }
  assert.equal(organizationQueryString({ q: ' ', estado: 'todas' }), '');
  assert.doesNotThrow(() => parseOrganizationQuery('?q=%E0%A4%A&estado=???'));
});
test('validación por campo: obligatorios, límites, normalización y duplicados', () => {
  const { state } = fixture();
  for (const field of ['name', 'managerName', 'email'] as const) {
    assert.ok(validateOrganizationField(state, field, '   '));
    assert.ok(validateOrganizationField(state, field, null));
  }
  for (const field of ['name', 'managerName'] as const) {
    for (const value of ['x', 'x'.repeat(81)]) assert.ok(validateOrganizationField(state, field, value));
    for (const value of ['ab', 'x'.repeat(80), '  María   Lagos  ']) assert.equal(validateOrganizationField(state, field, value), undefined);
  }
  for (const value of ['a@b', 'a b@c.cl', 'a@@b.cl', 'x'.repeat(116) + '@a.cl']) assert.ok(validateOrganizationField(state, 'email', value));
  assert.equal(validateOrganizationField(state, 'email', 'x'.repeat(115) + '@a.cl'), undefined);
  assert.match(validateOrganizationField(state, 'name', '  ESTÚDIO   creativo ')!, /Ya existe/);
  state.members[0].email = 'ángela@ejemplo.cl';
  assert.match(validateOrganizationField(state, 'email', 'ANGELA@EJEMPLO.CL')!, /Ya existe un miembro/);
  const valid = validateOrganization(state, { name: '  Nueva   organización ', managerName: ' María  Lagos ', email: ' MARIA@EJEMPLO.CL ' });
  assert.deepEqual(valid, { ok: true, value: input });
});
test('códigos finales del almacén se asignan a campo o aviso', () => {
  for (const [code, field] of [['duplicate_name', 'name'], ['duplicate_email', 'email'], ['invalid_input', 'managerName'], ['no_admin_session', undefined]] as const) {
    const error = organizationResultError({ ok: false, code: code as ErrorCode, field: code === 'invalid_input' ? 'managerName' : undefined, reason: 'Mensaje' });
    assert.equal(error.field, field); assert.ok(error.message);
  }
  assert.equal(organizationResultError({ ok: false, code: 'invalid_input', reason: 'Identificador repetido' }).field, undefined);
});
test('creación atómica: una escritura y revisión, sin cambios parciales ni sobrescritura en errores y carreras entre pestañas', () => {
  let raw: string | null = null, writes = 0;
  const storage = { getItem: () => raw, setItem: (key: string, value: string) => { assert.equal(key, PLATFORM_KEY); raw = value; writes++; } };
  const a = createPlatformStore(storage, { getSession: () => admin });
  const b = createPlatformStore(storage, { getSession: () => admin });
  try {
    const before = a.getState();
    assert.ok(a.createOrganization(input).ok);
    const after = a.getState(), organization = after.organizations.at(-1)!, member = after.members.at(-1)!;
    assert.equal(writes, 1); assert.equal(after.revision, before.revision + 1);
    assert.equal(member.organizationId, organization.id);
    assert.ok(after.memberAccess.some(access => access.organizationId === organization.id && access.userId === member.id));
    assert.equal(after.organizations.length, before.organizations.length + 1);
    assert.equal(after.members.length, before.members.length + 1);
    assert.equal(after.memberAccess.length, before.memberAccess.length + 1);
    assert.deepEqual(after.companies, before.companies);
    assert.deepEqual(JSON.parse(raw!), after);
    for (const draft of [{ ...input, name: ' NÚEVA ORGANIZACIÓN ' }, { ...input, name: 'Otra' }, { ...input, email: 'inválido' }]) {
      const snapshot = raw;
      const result = a.createOrganization(draft); assert.ok(!result.ok);
      assert.equal(a.getState(), after); assert.equal(raw, snapshot); assert.equal(writes, 1);
    }
    assert.ok(validateOrganization(b.getState(), input).ok); // validación local anterior al cambio externo
    const race = b.createOrganization(input); assert.ok(!race.ok); assert.equal(race.code, 'duplicate_name');
    assert.equal(writes, 1); assert.deepEqual(b.getState(), after);
    const restored = createPlatformStore(storage); assert.deepEqual(restored.getState(), after); restored.dispose();
  } finally { a.dispose(); b.dispose(); }
});
test('creada oculta por estado o búsqueda y visible tras limpiar', () => {
  const row = fixture().rows[0];
  assert.equal(matchesOrganization(row, { q: '', estado: 'suspendidas' }), false);
  assert.equal(matchesOrganization(row, { q: 'no coincide', estado: 'todas' }), false);
  assert.equal(matchesOrganization(row, { q: '', estado: 'todas' }), true);
});
test('CSS de foco específico, controles conservados y formulario sin credenciales', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /main\[tabindex="-1"\]:focus, main\[tabindex="-1"\]:focus-visible\s*\{\s*outline:\s*none;/);
  for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    if (!/outline\s*:\s*(?:none|0)\b/.test(match[2])) continue;
    assert.ok(!match[1].split(',').some(selector => /^(?:\*|:focus|:focus-visible|\*:focus|\*:focus-visible)$/.test(selector.trim())));
  }
  assert.match(css, /button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible\s*\{\s*outline:\s*3px/);
  const form = readFileSync(new URL('../src/features/platform/OrganizationForm.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(form, /password|contraseña|localStorage/);
  assert.match(form, /SIMULATED_INVITATION_NOTICE/);
  assert.match(form, /platformStore.createOrganization\(draft, workspace\)/);
});
