import { DomainError, ServiceUnavailableError } from '../common/errors/domain-error';

/**
 * Closed set of acceptance failures. Every message is fixed: none repeats the token, the email, the name, the password or any other
 * value the client or the database supplied.
 *  - 404 invitation_unavailable: unknown, malformed, revoked or already used token (one body for all of them).
 *  - 409 invitation_expired, account_exists, session_active.
 */
export const ACCEPTANCE_ERRORS = Object.freeze({
  invitation_unavailable: { status: 404, message: 'La invitación no está disponible.' },
  invitation_expired: { status: 409, message: 'La invitación venció. Pide una nueva a quien te invitó.' },
  account_exists: { status: 409, message: 'Ese correo ya tiene una cuenta. Inicia sesión para continuar.' },
  session_active: { status: 409, message: 'Cierra la sesión actual antes de aceptar la invitación.' },
} as const);
export type AcceptanceErrorCode = keyof typeof ACCEPTANCE_ERRORS;

export class InvitationAcceptanceError extends DomainError {
  constructor(code: AcceptanceErrorCode) { super(code, ACCEPTANCE_ERRORS[code].status, ACCEPTANCE_ERRORS[code].message); }
}

/** A clock earlier than the invitation's creation is an anomaly of the instance: a controlled, retryable 503 (never a masked success). */
export function clockBeforeCreationError(): ServiceUnavailableError { return new ServiceUnavailableError(undefined, 1); }

/**
 * Message of the 503 outcome_unknown of an acceptance whose commit could not be confirmed. Recovery, with no automatic retry:
 *  1. log in with the email of the invitation and the chosen password: if it works, the acceptance completed;
 *  2. a failed login alone does NOT prove the commit did not happen (typo, throttling, transient failure): wait a few seconds and
 *     repeat the acceptance once with the same link;
 *  3. 201: done; 404: the link was used (or is no longer available), so try the login again; 409 account_exists: the account exists
 *     (possibly created by that attempt), log in with the chosen password; if nothing works, ask for a new invitation.
 * The server keeps no idempotency state: that is outside the scope of this design.
 */
export const ACCEPTANCE_OUTCOME_UNKNOWN_MESSAGE =
  'No fue posible confirmar si la invitación se aceptó. Inicia sesión con tu correo y la contraseña elegida para comprobarlo; si no entras, eso no demuestra que no se aceptó: espera unos segundos y repite la aceptación una vez con el mismo enlace.';
