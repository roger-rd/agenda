import type { Role } from '../types';
export type Action = 'editOwnProfile' | 'viewSettings' | 'editOrganization' | 'editCompany' | 'viewTeam' | 'manageInvitations' | 'manageTeamAccess' | 'createPost' | 'editPost' | 'deletePost' | 'comment' | 'changeStatus' | 'createCompany' | 'viewCompanyPanel' | 'viewOrganization' | 'viewTeamVisibility' | 'viewAllCompanies' | 'viewHiddenPosts' | 'resetDemo';
const rules: Record<Action, readonly Role[]> = {
  editOwnProfile: ['community_manager', 'worker', 'client'],
  viewSettings: ['community_manager'],
  editOrganization: ['community_manager'],
  editCompany: ['community_manager'],
  viewTeam: ['community_manager'],
  manageInvitations: ['community_manager'],
  manageTeamAccess: ['community_manager'],
  createPost: ['community_manager', 'worker'],
  editPost: ['community_manager', 'worker'],
  deletePost: ['community_manager', 'worker'],
  comment: ['community_manager', 'worker', 'client'],
  changeStatus: ['community_manager', 'worker'],
  createCompany: ['community_manager'],
  viewCompanyPanel: ['community_manager', 'worker'],
  viewOrganization: ['community_manager', 'worker'],
  viewTeamVisibility: ['community_manager', 'worker'],
  viewAllCompanies: ['community_manager'],
  viewHiddenPosts: ['community_manager', 'worker'],
  resetDemo: ['community_manager'],
};
export const can = (role: Role, action: Action) => rules[action].includes(role);
