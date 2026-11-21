import { Invitation } from './invitation.entity';
import { InvitationCompany } from './invitation-company.entity';
import { Company } from './company.entity';
import { CompanyAccess } from './company-access.entity';
import { Organization } from './organization.entity';
import { OrganizationMembership } from './organization-membership.entity';
import { Post } from './post.entity';
import { PostComment } from './post-comment.entity';
import { User } from './user.entity';
import { UserSession } from './user-session.entity';

/**
 * The persistence model of the MVP. Deliberately NOT registered in any DataSource or module yet: the application
 * DataSource keeps `entities: []` until the migration system exists (F1.2).
 */
export const ENTITIES = Object.freeze([Organization, User, OrganizationMembership, Company, CompanyAccess, Post, PostComment, UserSession]);

export { Company, CompanyAccess, Organization, OrganizationMembership, Post, PostComment, User, UserSession };

/** Pending entities: activate together with their migration in a separately authorized block. */
export const INVITATION_ENTITIES = Object.freeze([Invitation, InvitationCompany]);
export { Invitation, InvitationCompany };
