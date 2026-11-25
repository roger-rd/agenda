import { invitationStatus, renewDecision, revokeDecision } from './invitation-status';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('estado calculado de la invitación', () => {
  it('abierta mientras no haya vencido, aceptado ni revocado', () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: at(1) }, NOW)).toBe('open');
  });
  it('vence exactamente en expiresAt: un milisegundo antes sigue abierta, en el instante ya no', () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: at(1) }, NOW)).toBe('open');
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: at(0) }, NOW)).toBe('expired');
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: at(-1) }, NOW)).toBe('expired');
  });
  it('aceptada y revocada se informan aunque haya vencido', () => {
    expect(invitationStatus({ acceptedAt: at(-5), revokedAt: null, expiresAt: at(-1) }, NOW)).toBe('accepted');
    expect(invitationStatus({ acceptedAt: null, revokedAt: at(-5), expiresAt: at(-1) }, NOW)).toBe('revoked');
  });
  it('precedencia definida si llegaran ambas: aceptada gana', () => {
    expect(invitationStatus({ acceptedAt: at(-5), revokedAt: at(-4), expiresAt: at(10) }, NOW)).toBe('accepted');
  });
  it('no depende del reloj del sistema: solo del instante recibido', () => {
    const row = { acceptedAt: null, revokedAt: null, expiresAt: new Date('2026-11-26T00:00:00.000Z') };
    expect(invitationStatus(row, new Date('2026-11-25T23:59:59.999Z'))).toBe('open');
    expect(invitationStatus(row, new Date('2026-11-26T00:00:00.000Z'))).toBe('expired');
  });
});

describe('decisiones de revocar y renovar', () => {
  it.each([['open', 'revoke'], ['expired', 'revoke'], ['revoked', 'already_revoked'], ['accepted', 'conflict']] as const)(
    'revocar una %s: %s', (status, decision) => expect(revokeDecision(status)).toBe(decision));
  it.each([['open', 'renew'], ['expired', 'renew'], ['revoked', 'conflict'], ['accepted', 'conflict']] as const)(
    'renovar una %s: %s', (status, decision) => expect(renewDecision(status)).toBe(decision));
});
