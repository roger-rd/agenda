export type Phase = 'offline' | 'readonly' | 'dml' | 'http' | 'auth' | 'companies' | 'companies-write' | 'invitations';
const PHASES: readonly string[] = ['offline', 'readonly', 'dml', 'http', 'auth', 'companies', 'companies-write', 'invitations'];
/** Closed list of PostgreSQL session time zones the invitations phase may run under (one full run per zone). */
export const INVITATION_TIME_ZONES = ['UTC', 'America/Santiago', 'Asia/Kolkata', 'Pacific/Chatham'] as const;
export type InvitationTimeZone = (typeof INVITATION_TIME_ZONES)[number];
/** The additional run changes the time zone of the Node process, which must differ from the PostgreSQL one. */
export const NODE_TIME_ZONE_EXTRA = 'Pacific/Kiritimati';
export function parsePhase(value: unknown, nodeEnv: unknown): Phase {
  if (value === 'cleanup') throw new Error('fase cleanup requiere autorización específica');
  if (typeof value !== 'string' || !PHASES.includes(value)) {
    throw new Error('AGENDA_B2B_PHASE obligatoria: offline, readonly, dml, http, auth, companies, companies-write o invitations (antes de importar pg/typeorm o leer DATABASE_*)');
  }
  if (nodeEnv !== 'test') throw new Error('NODE_ENV debe ser test');
  return value as Phase;
}
export function parseInvitationTimeZone(value: unknown): InvitationTimeZone {
  if (typeof value !== 'string' || !(INVITATION_TIME_ZONES as readonly string[]).includes(value)) {
    throw new Error(`AGENDA_B2B_TIMEZONE obligatoria en la fase invitations: ${INVITATION_TIME_ZONES.join(', ')}`);
  }
  return value as InvitationTimeZone;
}
/**
 * Optional guard for the extra run: AGENDA_B2B_EXPECT_NODE_TZ must be the Node zone the command set through TZ, must be the
 * allowed extra zone and must differ from the PostgreSQL zone. Without the variable nothing is asserted.
 */
export function assertNodeTimeZone(input: Record<string, string | undefined>, resolved: string): void {
  const expected = input.AGENDA_B2B_EXPECT_NODE_TZ;
  if (expected === undefined) return;
  if (expected !== NODE_TIME_ZONE_EXTRA) throw new Error(`AGENDA_B2B_EXPECT_NODE_TZ solo admite ${NODE_TIME_ZONE_EXTRA}`);
  if (resolved !== expected) throw new Error(`La zona de Node es ${resolved}; se esperaba ${expected} (TZ debe fijarse al lanzar el proceso)`);
  if (parseInvitationTimeZone(input.AGENDA_B2B_TIMEZONE) === (expected as string)) throw new Error('La zona de Node debe diferir de la de PostgreSQL');
}
export function phaseEnvironment(phase: Phase, input: Record<string, string | undefined>): Record<string, string | undefined> {
  const output = { ...input };
  if (phase === 'readonly') output.PGOPTIONS = '-c default_transaction_read_only=on';
  // Session configuration only (never ALTER ROLE/DATABASE): the zone reaches the observer, the locker and the application pool.
  else if (phase === 'invitations') output.PGOPTIONS = `-c TimeZone=${parseInvitationTimeZone(input.AGENDA_B2B_TIMEZONE)}`;
  else delete output.PGOPTIONS;
  return output;
}
