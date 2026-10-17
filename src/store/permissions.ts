import type { Role } from '../types';
export type Action = 'createCompany' | 'viewCompanyPanel' | 'viewOrganization' | 'viewTeamVisibility' | 'viewAllCompanies' | 'viewHiddenPosts' | 'resetDemo';
const rules: Record<Action, readonly Role[]> = {
    createCompany: ['community_manager'], viewCompanyPanel: ['community_manager', 'worker'], viewOrganization: ['community_manager', 'worker'], viewTeamVisibility: ['community_manager', 'worker'], viewAllCompanies: ['community_manager'], viewHiddenPosts: ['community_manager', 'worker'], resetDemo: ['community_manager'],
};
export const can = (role: Role, action: Action) => rules[action].includes(role);
