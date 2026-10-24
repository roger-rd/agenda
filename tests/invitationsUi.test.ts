import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import type { Invitation } from '../src/types';
import { invitationActions, invitationCompanies, invitationErrors, invitationLink, invitationList } from '../src/features/team/invitationsPresentation';
import { recoverAccessDraft } from '../src/features/team/teamPresentation';
import { canManageTeam } from '../src/store/invitations';
const now = Date.parse('2026-10-22T12:00:00Z');
function fixture() {
  const s = generateDemo();
  const invitation: Invitation = { id: '1', code: 'abc', organizationId: s.organization.id, email: 'persona@example.cl', role: 'client', companyIds: ['company-0', 'eliminada'], validityDays: 7, createdAt: '2026-10-21T12:00:00Z', expiresAt: new Date(now + 1).toISOString() };
  s.invitations = [invitation, { ...invitation, id: '2', code: 'def', usedAt: invitation.createdAt },
    { ...invitation, id: '3', code: 'ghi', revokedAt: invitation.createdAt },
    { ...invitation, id: '4', code: 'jkl', createdAt: '2026-10-22T11:00:00Z', expiresAt: new Date(now).toISOString() }];
  return s;
}
test('filtros, contadores y orden con reloj inyectado en el límite exacto', () => {
  const s = fixture(), all = invitationList(s, 'todas', now);
  assert.deepEqual(all.counts, { todas: 4, pendiente: 1, usada: 1, revocada: 1, vencida: 1 });
  assert.equal(all.rows[0].id, '4');
  for (const status of ['pendiente', 'usada', 'revocada', 'vencida'] as const)
    assert.equal(invitationList(s, status, now).rows.length, 1);
  assert.equal(invitationList(s, 'pendiente', now + 1).rows.length, 0);
  assert.equal(invitationList(s, 'vencida', now + 1).counts.vencida, 2);
  assert.equal(invitationList({ ...s, invitations: [] }, 'todas', now).counts.todas, 0);
});
test('acciones por estado: solo pendiente copia/revoca, usada nunca renueva', () => {
  assert.deepEqual(invitationActions('pendiente'), { copy: true, revoke: true, renew: true });
  for (const status of ['revocada', 'vencida'] as const)
    assert.deepEqual(invitationActions(status), { copy: false, revoke: false, renew: true });
  assert.deepEqual(invitationActions('usada'), { copy: false, revoke: false, renew: false });
});
test('nombres actuales y empresa eliminada; enlace navegable del mismo origen solo para pendientes', () => {
  const s = fixture(); s.companies[0].name = 'Nombre actual';
  assert.deepEqual(invitationCompanies(s, s.invitations[0]), ['Nombre actual', 'empresa eliminada']);
  assert.equal(invitationLink('http://localhost:5174', 'abc'), 'http://localhost:5174/invitacion/abc');
  const source = readFileSync(new URL('../src/features/team/Invitations.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Link\b|\bnavigate\s*\(/);
  const links = [...source.matchAll(/<a href=\{`([^`]+)`\} target="_blank" rel="noopener noreferrer">Abrir enlace<\/a>/g)];
  assert.equal(links.length, 2);
  assert.deepEqual(links.map(m => m[1]), ['/invitacion/${invitation.code}', '/invitacion/${i.code}']);
  assert.match(source, /if \(!current \|\| invitationStatus\(current\) !== 'pendiente'\) return/);
  assert.match(source, /available.copy && <>.*Abrir enlace/);
  assert.doesNotMatch(source, /La aceptación del enlace estará disponible/);
  assert.match(source, /result \? \(editor.mode === 'renew' \? 'Invitación renovada' : 'Invitación creada'\)/);
});
test('conflicto conserva todos los campos, exige refresh y no ejecuta reintento', () => {
  const draft = { email: ' persona@example.cl ', role: 'client', companyIds: ['company-0'], validityDays: 30, message: '', ready: true };
  let reads = 0;
  const blocked = recoverAccessDraft(draft, { ok: false, code: 'conflict', reason: 'Conflicto' }, () => { reads++; return false; });
  assert.equal(reads, 1); assert.equal(blocked.ready, false);
  assert.deepEqual({ ...blocked, message: '', ready: true }, draft);
  const refreshed = recoverAccessDraft(blocked, { ok: false, code: 'conflict', reason: 'Conflicto' }, () => { reads++; return true; });
  assert.equal(reads, 2); assert.equal(refreshed.ready, true);
});
test('todos los rechazos refrescan sin perder borrador', () => {
  for (const code of ['storage_unavailable', 'organization_unavailable', 'invalid_companies', 'existing_member', 'forbidden', 'used', 'not_found'] as const) {
    let called = false;
    const next = recoverAccessDraft({ email: 'persona@example.cl', message: '', ready: true }, { ok: false, code, reason: 'Error' }, () => { called = true; return false; });
    assert.ok(called); assert.equal(next.ready, false); assert.equal(next.email, 'persona@example.cl');
  }
});
test('validaciones por campo y permiso exclusivo del CM', () => {
  const invalid = invitationErrors({ email: '', role: 'worker', companyIds: [], validityDays: 7 });
  assert.ok(invalid.email); assert.ok(invalid.companyIds); assert.equal(invalid.role, '');
  assert.ok(invitationErrors({ email: 'a'.repeat(121) + '@example.cl', role: 'client', companyIds: ['company-0'] }).email);
  const s = fixture(); s.authenticated = true;
  assert.ok(canManageTeam(s)); assert.equal(canManageTeam(s, true), false);
  for (const role of ['worker', 'client'] as const) {
    const user = s.users.find(u => u.role === role)!;
    assert.equal(canManageTeam({ ...s, role, activeUserId: user.id }), false);
  }
});
