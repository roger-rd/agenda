import { useSyncExternalStore } from 'react';
import { platformStore, browserLocalStorage } from '../platform/store';
import { workspacePolicy } from '../platform/access';
import { adminSession } from '../platform/session';
import { attachmentFiles } from '../features/posts/attachmentFiles';
import { createWorkspaceStore } from './workspace';
export { createWorkspaceStore } from './workspace';
const store = createWorkspaceStore(browserLocalStorage(), {
  getPlatform: () => { platformStore.refresh(); return workspacePolicy(platformStore.getState()); },
  hasAdminSession: () => !!adminSession.getSession(), closeAdminSession: () => adminSession.setSession(null),
});
store.subscribe(() => {
  const retained = new Set(store.getState().posts.flatMap(p => p.attachments.map(a => a.id)));
  for (const id of attachmentFiles.keys()) if (!retained.has(id)) attachmentFiles.delete(id);
});
export const useStore = () => useSyncExternalStore(store.subscribe, store.getState);
export const getState = store.getState;
export const getStorageWarning = store.getStorageWarning;
export const updateWorkspaceSession = store.updateSession;
export const actions = store.actions;
