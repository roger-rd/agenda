import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { workspacePolicy } from '../src/platform/access';
import { createWorkspaceStore, WORKSPACE_KEY } from '../src/store/workspace';
import { can } from '../src/store/permissions';
import { avatarStyle } from '../src/components/ui';
import { contrastRatio, readableTextColor } from '../src/lib/color';
import { buildSubmission, editDraft, fieldErrors, isDirty, needsDiscardConfirmation, recoverDraft, recoveryMessages, settingsDraft, submissionHasChanges, submitState } from '../src/features/settings/settingsPresentation';
import type { Result } from '../src/store/operations';
const state = () => ({ ...generateDemo(), authenticated: true });
const failure = (code: Extract<Result, { ok: false }>['code'], field?: 'name' | 'color'): Extract<Result, { ok: false }> => ({ ok: false, code, field, reason: 'Error del almacén' });
for (const length of [0, 1, 2, 80, 81]) test(`UI: nombre limpio de longitud ${length}`, () => {
  const s = state();
  for (const id of [undefined, s.companies[0].id]) {
    const d = editDraft(settingsDraft(s, id), 'name', `  ${'A'.repeat(length)}  `);
    assert.equal(!!fieldErrors(s, d).name, length < 2 || length > 80);
  }
});
test('UI: duplicado normalizado, exclusión propia y nombres heredados sin modificación', () => {
  const s = state(), id = s.companies[0].id;
  s.companies[0].name = 'Café Central'; s.companies[1].name = 'Otra Empresa';
  assert.equal(fieldErrors(s, editDraft(settingsDraft(s, id), 'name', ' CAFÉ   CENTRAL ')).name, undefined);
  assert.ok(fieldErrors(s, editDraft(settingsDraft(s, id), 'name', ' otra   émpresa ')).name);
  s.companies[1].name = 'Café Central';
  assert.equal(fieldErrors(s, editDraft(settingsDraft(s, id), 'color', '#ffffff')).name, undefined);
  s.companies[0].name = 'X';
  assert.equal(fieldErrors(s, editDraft(settingsDraft(s, id), 'color', '#ffffff')).name, undefined);
});
for (const color of ['#ffffff', '#FFFF00', '#000000', '#000080', '#abcdef', '#fff', 'red', '#gggggg', '']) test(`UI: color ${color}`, () => {
  const s = state(), d = editDraft(settingsDraft(s, s.companies[0].id), 'color', color);
  assert.equal(!!fieldErrors(s, d).color, !/^#[a-f0-9]{6}$/i.test(color));
});
test('UI: dirty, descarte y envío exclusivamente por campos modificados', () => {
  const s = state(), c = s.companies[0], base = settingsDraft(s, c.id);
  assert.equal(isDirty(base), false); assert.equal(submitState(s, base).disabled, true);
  assert.equal(needsDiscardConfirmation(editDraft(base, 'name', ` ${c.name} `)), false);
  const name = editDraft(base, 'name', ' Empresa Nueva ');
  assert.equal(submitState(s, name).disabled, false); assert.equal(needsDiscardConfirmation(name), true);
  assert.deepEqual(buildSubmission(name), { companyId: c.id, changes: { name: 'Empresa Nueva' }, expected: { name: c.name } });
  const color = editDraft(base, 'color', '#FFFF00');
  assert.deepEqual(buildSubmission(color), { companyId: c.id, changes: { color: '#ffff00' }, expected: { color: c.color } });
  assert.deepEqual(buildSubmission(editDraft(name, 'color', '#ffffff')).expected, { name: c.name, color: c.color });
});
for (const code of ['conflict', 'storage_unavailable', 'duplicate_name', 'invalid_color', 'invalid_input', 'forbidden', 'not_found'] as const) test(`UI: recuperación y etiqueta para ${code}`, () => {
  const s = state(), c = s.companies[0], base = editDraft(settingsDraft(s, c.id), 'name', 'Mi borrador');
  const fresh = structuredClone(s); fresh.companies[0].name = 'Nombre concurrente';
  const recovered = recoverDraft(base, failure(code, 'name'), fresh, true);
  assert.deepEqual(recovered.values, base.values); assert.deepEqual(recovered.base, base.base);
  const transient = code === 'conflict' || code === 'storage_unavailable';
  assert.equal(submitState(fresh, recovered).label, transient ? 'Reintentar' : 'Guardar');
  assert.equal(submitState(fresh, recovered).disabled, code === 'forbidden' || code === 'not_found');
  assert.equal(buildSubmission(recovered).expected.name, transient ? 'Nombre concurrente' : c.name);
  assert.equal(fieldErrors(fresh, recovered).name, transient ? undefined : 'Error del almacén');
  if (transient) {
    assert.ok(recoveryMessages(recovered).join('').includes('Nombre concurrente'));
    const failedRefresh = recoverDraft(base, failure(code), fresh, false);
    assert.equal(submitState(fresh, failedRefresh).disabled, true);
    assert.equal(buildSubmission(failedRefresh).expected.name, c.name);
    assert.ok(recoveryMessages(failedRefresh).join('').includes('No se pudieron'));
  }
});
test('UI: desaparición, error de color y reintento sin cambio efectivo', () => {
  const s = state(), c = s.companies[0], d = editDraft(settingsDraft(s, c.id), 'color', '#ffffff');
  const fresh = structuredClone(s); fresh.companies[0].color = '#ffffff';
  const recovered = recoverDraft(d, failure('conflict', 'color'), fresh, true);
  assert.equal(submissionHasChanges(recovered), false);
  assert.ok(recoveryMessages(recovered).join('').includes('#ffffff'));
  assert.equal(fieldErrors(s, recoverDraft(d, failure('invalid_color', 'color'), s, true)).color, 'Error del almacén');
  fresh.companies = [];
  assert.equal(submitState(fresh, recoverDraft(d, failure('conflict'), fresh, true)).disabled, true);
});
test('UI: permiso y guarda reactiva de ajustes', () => {
  assert.equal(can('community_manager', 'viewSettings'), true);
  for (const role of ['worker', 'client', 'platform_admin'] as const) assert.equal(can(role as Parameters<typeof can>[0], 'viewSettings'), false);
  const source = readFileSync('src/features/workspace/Workspace.tsx', 'utf8');
  assert.match(source, /path="\/ajustes" element=\{can\(s.role, 'viewSettings'\) \? <Settings \/> : <Navigate to=\{home\} replace \/>/);
  assert.match(source, /can\(s.role, 'viewSettings'\) && <Link to="\/ajustes"/);
});
for (const color of ['#ffff00', '#ffffff', '#000000', '#000080', '#5753c9']) test(`Avatar: máximo contraste ${color}`, () => {
  const style = avatarStyle(color);
  assert.equal(style.background, color); assert.equal(style.color, readableTextColor(color));
  assert.ok(contrastRatio(color, style.color) >= contrastRatio(color, style.color === '#ffffff' ? '#111111' : '#ffffff'));
  assert.match(readFileSync('src/components/ui.tsx', 'utf8'), /style=\{avatarStyle\(color\)\}/);
});
test('UI + almacén real compartido: renombrar conserva profundamente relaciones y contenido', () => {
  const initial = state(), data = new Map([[WORKSPACE_KEY, JSON.stringify(initial)]]);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  const options = { getPlatform: () => workspacePolicy(generatePlatformSeed()) };
  const store = createWorkspaceStore(storage, options), other = createWorkspaceStore(storage, options);
  assert.ok(store.actions.createInvitation({ email: 'nueva@example.com', role: 'worker', companyIds: [initial.companies[0].id] }).ok);
  const before = structuredClone(store.getState());
  const org = buildSubmission(editDraft(settingsDraft(before), 'name', 'Organización Nueva'));
  assert.ok(store.actions.updateOrganization({ name: org.changes.name!, expectedName: org.expected.name! }).ok);
  const company = buildSubmission(editDraft(settingsDraft(before, before.companies[0].id), 'name', 'Empresa Nueva'));
  assert.ok(store.actions.updateCompany(company).ok);
  assert.equal(other.actions.refresh(), true);
  assert.deepEqual(other.getState(), { ...before, revision: before.revision + 2, organization: { ...before.organization, name: 'Organización Nueva' }, companies: before.companies.map((c, i) => i ? c : { ...c, name: 'Empresa Nueva' }) });
});
