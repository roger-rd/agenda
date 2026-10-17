import { useSyncExternalStore } from 'react';
import type { Role, State } from '../types';
import { generateDemo } from '../data/demo';
import { can } from './permissions';
import { selectCompanies } from './selectors';
const KEY = 'agenda-demo-v1';
function restore(): State { try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
        const s = JSON.parse(raw);
        if (s.version === 1 && Array.isArray(s.posts) && Array.isArray(s.companies) && Array.isArray(s.users) && Array.isArray(s.memberships) && ['community_manager', 'worker', 'client'].includes(s.role))
            return s;
    }
}
catch { /* Storage can be unavailable. */ } return generateDemo(); }
let state = restore();
const listeners = new Set<() => void>();
let storageWarning = '';
function update(next: State) { state = next; try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageWarning = '';
}
catch {
    storageWarning = 'No se pudieron guardar los cambios en este navegador. Se conservarán durante esta sesión.';
} listeners.forEach(l => l()); }
export const useStore = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => state);
export const getStorageWarning = () => storageWarning;
export const actions = {
    login: () => update({ ...state, authenticated: true, role: 'community_manager' }),
    logout: () => update({ ...state, authenticated: false }),
    setRole: (role: Role) => { const next = { ...state, role }; next.activeCompanyId = selectCompanies(next)[0]?.id ?? ''; update(next); },
    setCompany: (id: string) => { if (selectCompanies(state).some(c => c.id === id))
        update({ ...state, activeCompanyId: id }); },
    createCompany: (name: string, color: string) => { if (!can(state.role, 'createCompany') || !name.trim())
        return; const id = crypto.randomUUID(); update({ ...state, companies: [...state.companies, { id, name: name.trim().slice(0, 80), color, organizationId: state.organization.id }] }); },
    reset: () => { if (can(state.role, 'resetDemo'))
        update({ ...generateDemo(), authenticated: true }); },
};
