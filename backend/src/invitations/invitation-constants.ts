/** Validity options offered by the frontend (`Invitation.validityDays`); 7 is the default. */
export const INVITATION_VALIDITY_DAYS = [1, 7, 30] as const;
export type InvitationValidityDays = (typeof INVITATION_VALIDITY_DAYS)[number];
export const DEFAULT_INVITATION_VALIDITY_DAYS: InvitationValidityDays = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** An invitation always grants access to at least one company and at most this many. */
export const INVITATION_MIN_COMPANIES = 1;
export const INVITATION_MAX_COMPANIES = 50;

/** The community manager is never invited: only the roles that receive explicit company accesses. */
/** Mirrors the closed role set of the invitations CHECK; kept local because only the persistence layer may import its entities. */
export const INVITATION_ROLES = ['worker', 'client'] as const;
export type InvitationRole = (typeof INVITATION_ROLES)[number];

/** Derived by the server from the row and the clock; it is not a column. */
export const INVITATION_STATUSES = ['open', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Path of the invitation page in the frontend. The token travels in the fragment, which browsers never send to a server. */
export const INVITATION_LINK_PATH = '/invitacion';
