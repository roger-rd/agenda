import { deriveCsrfToken, generateSessionToken, hashSessionToken } from '../identity/session-token';
import { deriveStructure } from '../database/schema-runner/schema-structure';
import { UP_STATEMENTS } from '../database/migrations/initial-schema.statements';
import { INSERT_SESSION_SQL, issueSession, sessionInsertParams } from './session-issue';
import { SESSION_POLICY } from './session-policy';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const token = generateSessionToken(() => Buffer.alloc(32, 5));
const input = { now: NOW, token, id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', activeOrganizationId: '01900000-0000-7000-8000-000000000003' };

describe('creación de sesión compartida por el login y la aceptación de invitaciones', () => {
  it('aplica la política: caducidad y duración de cookie del mínimo entre inactividad y absoluto', () => {
    const issue = issueSession(input);
    const seconds = Math.min(SESSION_POLICY.idleSeconds, SESSION_POLICY.absoluteSeconds);
    expect(issue.maxAgeSeconds).toBe(seconds);
    expect(issue.expiresAt).toEqual(new Date(NOW.getTime() + seconds * 1000));
    expect(issue.token).toBe(token); expect(issue.csrfToken).toBe(deriveCsrfToken(token));
  });
  it('la fila guarda el hash del token, nunca el token, con creación y última vista iguales y sin revocar', () => {
    const { row } = issueSession(input);
    expect(row).toEqual({ id: input.id, tokenHash: hashSessionToken(token), userId: input.userId, activeOrganizationId: input.activeOrganizationId,
      createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + 7 * 86400000), revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toHaveLength(32);
  });
  it('admite una sesión sin organización activa y no modifica sus entradas', () => {
    const now = new Date(NOW);
    expect(issueSession({ ...input, now, activeOrganizationId: null }).row.activeOrganizationId).toBeNull();
    expect(now.getTime()).toBe(NOW.getTime());
  });
  it('un token que no es de sesión se rechaza antes de hashear', () => {
    expect(() => issueSession({ ...input, token: 'corto' })).toThrow('Token de sesión inválido');
  });
  it('INSERT_SESSION_SQL: parámetros contiguos, columnas del esquema aplicado y valores iguales a los de la fila', () => {
    const columns = new Set(deriveStructure(UP_STATEMENTS).filter(r => r.kind === 'col' && r.table_name === 'user_sessions').map(r => r.name));
    const listed = /\(([^)]+)\) VALUES/.exec(INSERT_SESSION_SQL)![1].split(',').map(c => c.trim());
    expect(listed.every(c => columns.has(c))).toBe(true);
    expect(listed).toHaveLength(8);
    expect([...new Set([...INSERT_SESSION_SQL.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(INSERT_SESSION_SQL).toContain('VALUES ($1, $2, $3, $4, $5, $5, $6, NULL)');
    const { row } = issueSession(input);
    expect(sessionInsertParams(row)).toEqual([row.id, row.tokenHash, row.userId, row.activeOrganizationId, row.createdAt, row.expiresAt]);
  });
});
