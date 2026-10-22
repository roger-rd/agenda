import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { createPlatformStore, PLATFORM_KEY } from '../src/platform/store';
import { accessCausesForWorkspace, resolveAccess } from '../src/platform/access';
import { currentUserId, workspaceOrganizationId, selectUser } from '../src/store/selectors';
import { createAccessGuard } from '../src/store/accessGuard';
import { accessMessage, ACCESS_CONTACT, ACCESS_SIMULATION } from '../src/features/access/accessMessages';
import { resolveWorkspaceGate } from '../src/features/access/workspaceGate';
import { WORKSPACE_BLOCKING_NOTICE } from '../src/features/platform/detailLogic';
import { LINKED_ORGANIZATION_ID as linked, PLATFORM_ADMIN_ID } from '../src/platform/ids';
import type { AdminSession } from '../src/platform/types';
const admin: AdminSession = { kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID };
class Storage {
  data = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value); }
}
test('identidad simulada, directorio e ids estables al regenerar', () => {
  const s = generateDemo();
  for (const [role, id, name] of [['community_manager', 'edison', 'Edison Valera'], ['worker', 'ana', 'Ana Torres'], ['client', 'roger', 'Roger Rodríguez']] as const) {
    const state = { ...s, role };
    assert.equal(currentUserId(state), id); assert.equal(selectUser(state).name, name);
  }
  assert.equal(workspaceOrganizationId(s), linked);
  assert.deepEqual(generateDemo().users.map(u => u.id), s.users.map(u => u.id));
});
for (const organization of ['active', 'suspended', 'unknown'] as const) for (const member of ['active', 'suspended'] as const) {
  test(`matriz de acceso y mensajes: ${organization}/${member}`, () => {
    const s = generatePlatformSeed();
    if (organization === 'unknown') s.organizations = s.organizations.filter(o => o.id !== linked);
    else s.organizations[0] = { ...s.organizations[0], status: organization, suspension: { at: '2026-01-01', reason: 'SECRETO PRIVADO' } };
    s.memberAccess[0] = { ...s.memberAccess[0], status: member, suspension: { at: '2026-01-01', reason: 'SECRETO INDIVIDUAL' } };
    const causes = accessCausesForWorkspace(s, linked, 'edison');
    assert.deepEqual(causes, { allowed: organization === 'active' && member === 'active', organizationSuspended: organization === 'suspended', memberSuspended: member === 'suspended', organizationUnknown: organization === 'unknown' });
    assert.ok(Object.values(causes).every(value => typeof value === 'boolean'));
    assert.equal(resolveAccess(s, linked, 'edison').allowed, causes.allowed);
    assert.equal(resolveWorkspaceGate('workspace', causes).access, causes.allowed ? 'allowed' : 'blocked');
    for (const session of ['none', 'platform_admin'] as const) assert.equal(resolveWorkspaceGate(session, causes).access, 'blocked');
    const message = accessMessage(causes);
    assert.doesNotMatch(message + ACCESS_CONTACT + ACCESS_SIMULATION, /SECRETO/);
    if (organization === 'unknown') assert.equal(message, 'La organización no está disponible.');
    else if (organization === 'suspended' && member === 'suspended') assert.equal(message, 'La organización está suspendida y tu acceso individual también. Al reactivar la organización seguirás bloqueado hasta que se reactive tu acceso.');
    else if (organization === 'suspended') assert.equal(message, 'La organización está suspendida. Todos sus miembros están bloqueados.');
    else if (member === 'suspended') assert.equal(message, 'Tu acceso individual está suspendido. El resto de los miembros no se ve afectado.');
    else assert.equal(message, '');
  });
}
test('dos pestañas: gate, guarda fresca sin evento, reactivación parcial y ausencia de cola', () => {
  const storage = new Storage(), windowTarget = new EventTarget(), documentTarget = new EventTarget();
  const a = createPlatformStore(storage, { getSession: () => admin });
  const b = createPlatformStore(storage, { getSession: () => null, windowTarget, documentTarget });
  const workspace = { ...generateDemo(), authenticated: true, role: 'worker' as const };
  const before = JSON.stringify(workspace);
  const guard = createAccessGuard({ getWorkspaceState: () => workspace, isAccessAllowed: b.isAccessAllowed });
  const gate = () => resolveWorkspaceGate('workspace', accessCausesForWorkspace(b.getState(), linked, 'ana')).access;
  let notifications = 0; b.subscribe(() => notifications++);
  try {
    a.suspendMember({ organizationId: linked, userId: 'ana', reason: 'Privado' });
    assert.equal(gate(), 'allowed'); assert.equal(guard(), false); assert.equal(gate(), 'blocked');
    assert.equal(accessCausesForWorkspace(b.getState(), linked, 'roger').allowed, true);
    a.suspendOrganization({ organizationId: linked });
    const event = new Event('storage'); Object.defineProperty(event, 'key', { value: PLATFORM_KEY }); windowTarget.dispatchEvent(event);
    assert.equal(gate(), 'blocked');
    a.reactivateOrganization({ organizationId: linked }); windowTarget.dispatchEvent(new Event('focus'));
    assert.equal(gate(), 'blocked'); assert.equal(guard(), false);
    a.reactivateMember({ organizationId: linked, userId: 'ana' }); documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(gate(), 'allowed'); assert.equal(guard(), true);
    assert.equal(JSON.stringify(workspace), before); assert.equal(notifications, 4);
  } finally { a.dispose(); b.dispose(); }
});
test('mantenimiento sin administrador elimina solo huérfanos, relee y no escribe sin cambios', () => {
  const storage = new Storage(); const initial = generatePlatformSeed();
  initial.memberAccess.push({ organizationId: linked, userId: 'deleted', status: 'active' });
  storage.setItem(PLATFORM_KEY, JSON.stringify(initial));
  const a = createPlatformStore(storage, { getSession: () => admin });
  const b = createPlatformStore(storage, { getSession: () => null });
  try {
    a.suspendOrganization({ organizationId: linked, reason: 'Organización privada' });
    a.suspendMember({ organizationId: linked, userId: 'ana', reason: 'Persona privada' });
    const before = a.getState(); const writes = storage.writes;
    assert.equal(b.reconcileWithWorkspace(generateDemo().users.map(u => u.id)), true);
    const after = b.getState();
    assert.deepEqual(after.organizations, before.organizations);
    assert.deepEqual(after.memberAccess, before.memberAccess.filter(m => m.userId !== 'deleted'));
    assert.equal(after.revision, before.revision + 1); assert.equal(storage.writes, writes + 1);
    assert.equal(b.reconcileWithWorkspace(generateDemo().users.map(u => u.id)), false);
    assert.equal(b.getState(), after); assert.equal(storage.writes, writes + 1);
    assert.equal(b.resetPlatform().ok, false);
    assert.equal(a.resetPlatform().ok, true);
    assert.deepEqual(a.getState().memberAccess, generatePlatformSeed().memberAccess);
  } finally { a.dispose(); b.dispose(); }
});
test('aviso conectado y gate antes de montar contenido, selector compartido, sin autoguardado', () => {
  assert.equal(WORKSPACE_BLOCKING_NOTICE, 'La suspensión se aplica al espacio de trabajo de demostración en este navegador (simulación local, sin protección real de servidor).');
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const app = source('App.tsx');
  assert.ok(app.indexOf('if (blocked) return <AccessSuspended') < app.indexOf('<Workspace key='));
  assert.match(app, /useSyncExternalStore\(platformStore.subscribe, platformStore.getState\)/);
  assert.doesNotMatch(app, /selectPosts|selectPost\(|selectComments/);
  for (const file of ['features/workspace/ProfileMenu.tsx', 'features/access/AccessSuspended.tsx']) assert.match(source(file), /<DemoMode/);
  assert.match(source('features/access/AccessSuspended.tsx'), /role="alert"/);
  assert.match(source('features/workspace/Workspace.tsx'), /role="status"/);
  const cleanup = source('features/posts/PostForm.tsx').split('return () => {')[1].split('};')[0];
  assert.doesNotMatch(cleanup, /actions\.|submit|savePost/);
});
