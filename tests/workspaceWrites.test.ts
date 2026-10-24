import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo } from '../src/data/demo';
import { generatePlatformSeed } from '../src/platform/seed';
import { PLATFORM_ADMIN_ID, LINKED_ORGANIZATION_ID as linked } from '../src/platform/ids';
import { attachmentFiles } from '../src/features/posts/attachmentFiles';

test('todas las escrituras públicas bloqueadas sin mutación; sesiones, cambio de usuario y restablecimientos independientes', async () => {
  const data = new Map<string, string>(); let writes = 0; const keys: string[] = [];
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { writes++; keys.push(key); data.set(key, value); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const { actions, getState } = await import('../src/store');
  const { platformStore, createPlatformStore, PLATFORM_KEY } = await import('../src/platform/store');
  const a = createPlatformStore(storage, { getSession: () => ({ kind: 'platform_admin', adminId: PLATFORM_ADMIN_ID }) });
  try {
    for (const cause of ['organization', 'member', 'both', 'unknown'] as const) {
      a.resetPlatform(); actions.login(); actions.reset();
      if (cause === 'organization' || cause === 'both') a.suspendOrganization({ organizationId: linked, reason: 'Motivo privado org' });
      if (cause === 'member' || cause === 'both') a.suspendMember({ organizationId: linked, userId: 'edison', reason: 'Motivo privado usuario' });
      if (cause === 'unknown') {
        const seed = generatePlatformSeed(); seed.organizations = seed.organizations.filter(o => o.id !== linked);
        storage.setItem(PLATFORM_KEY, JSON.stringify(seed));
      }
      // No se ha entregado storage: la primera acción tiene una copia obsoleta.
      const before = getState(), snapshot = JSON.stringify(before), count = writes, post = before.posts[0];
      const files = [...attachmentFiles];
      const attempts = [() => actions.createPost(post), () => actions.updatePost(post.id, { ...post, title: 'No debe guardarse' }),
        () => actions.deletePost(post.id), () => actions.changeStatus(post.id, 'Subido'), () => actions.addComment(post.id, 'No debe guardarse'),
        () => actions.createCompany('No debe crearse', '#000000'), () => actions.setCompany('company-1'), () => actions.reset()];
      for (const attempt of attempts) {
        assert.deepEqual(attempt(), { ok: false, code: 'forbidden', reason: 'Tu acceso a esta organización está suspendido.' });
        assert.equal(getState(), before); assert.equal(JSON.stringify(getState()), snapshot); assert.equal(writes, count);
        assert.deepEqual([...attachmentFiles], files);
      }
      a.resetPlatform(); platformStore.refresh();
      assert.equal(getState(), before); assert.equal(JSON.stringify(getState()), snapshot); // Sin cola ni reintentos.
      assert.equal(actions.createCompany('Permitida', '#000000').ok, true);
      assert.equal(actions.createPost(post).ok, true);
      assert.equal(actions.updatePost(post.id, { ...post, title: 'Permitida' }).ok, true);
      assert.equal(actions.changeStatus(post.id, 'Subido').ok, true);
      assert.equal(actions.addComment(post.id, 'Permitido').ok, true);
      assert.equal(actions.deletePost(post.id).ok, true);
      assert.equal(actions.setCompany('company-1').ok, true);
    }
    a.suspendOrganization({ organizationId: linked });
    actions.logout(); assert.equal(getState().authenticated, false);
    actions.login(); assert.equal(getState().authenticated, true);
    for (const role of ['worker', 'client', 'community_manager'] as const) {
      assert.equal(actions.setRole(role).ok, true); assert.equal(getState().role, role);
    }
    a.reactivateOrganization({ organizationId: linked });
    a.suspendMember({ organizationId: linked, userId: 'ana' });
    const platformBefore = JSON.stringify(a.getState());
    const persisted = data.get(PLATFORM_KEY), cursor = keys.length;
    assert.equal(actions.reset().ok, true); // Edison permitido, Ana continúa suspendida.
    assert.equal(JSON.stringify(a.getState()), platformBefore);
    assert.equal(data.get(PLATFORM_KEY), persisted);
    assert.ok(keys.slice(cursor).every(key => ['agenda-demo-v2', 'agenda-demo-v2:lock'].includes(key)));
    platformStore.reconcileWithWorkspace(getState().users.map(user => user.id));
    assert.deepEqual(platformStore.getState(), JSON.parse(platformBefore));
    assert.ok(platformStore.getState().memberAccess.filter(access => access.organizationId === linked).every(access => getState().users.some(user => user.id === access.userId)));
    assert.deepEqual(getState().users.map(u => u.id), generateDemo().users.map(u => u.id));
    actions.setRole('worker'); assert.equal(actions.addComment('busy-1', 'Bloqueado').ok, false);
    assert.equal(platformStore.isAccessAllowed(linked, 'ana').allowed, false);
    const workspaceBefore = getState(); a.resetPlatform(); platformStore.refresh();
    assert.equal(getState(), workspaceBefore); assert.equal(platformStore.isAccessAllowed(linked, 'ana').allowed, true);
    assert.ok(getState().users.every(u => a.getState().memberAccess.some(m => m.userId === u.id)));
  } finally {
    actions.logout(); a.dispose(); platformStore.dispose();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
