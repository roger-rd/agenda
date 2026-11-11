import { SCHEMA_MANIFEST } from '../migrations/schema-manifest';
import { ConstraintRegistry } from './constraint-registry';
import { registerSchemaConstraints, SCHEMA_CONSTRAINTS } from './register-schema-constraints';
it('todos los nombres exactos existen en el manifiesto, sin duplicados ni internos', () => {
  const schema = SCHEMA_MANIFEST.flatMap(entry => entry.up).join('\n');
  const registry = registerSchemaConstraints(new ConstraintRegistry());
  expect(registry.size).toBe(SCHEMA_CONSTRAINTS.length);
  for (const entry of SCHEMA_CONSTRAINTS) {
    expect(schema).toContain(`CONSTRAINT "${entry.name}"`);
    expect(entry.name).not.toMatch(/_id_|_v7|_version|_hash|_times/);
    expect(entry.field).toBeTruthy();
    expect(entry.kind === 'unique' ? registry.unique(entry.name) : registry.check(entry.name)).toEqual(entry);
  }
});

// También ejercita el recorrido completo sin sockets, útil en sandboxes sin listen.
import { ArgumentsHost } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { Uuid7Generator } from '../../common/ids/uuid7-generator';
import { extractDatabaseFields } from '../../logging/error-sanitizer';
import { classifyDatabaseError } from './database-failure';
it.each(['UQ_users_email', 'uq_users_email', 'UQ_unknown'])('recorrido exacto hasta filtro %s', constraint => {
  const simulated = { code: '23505', severity: 'ERROR', constraint, table: 'users', column: 'email' };
  expect(extractDatabaseFields(simulated).constraint).toBe(constraint);
  expect(classifyDatabaseError(simulated)?.constraint).toBe(constraint);
  const logger = { logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } } as unknown as PinoLogger;
  const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers: {}, id: 'constraint-test' }), getResponse: () => response }) } as ArgumentsHost;
  new AllExceptionsFilter(logger, new Uuid7Generator(), registerSchemaConstraints(new ConstraintRegistry())).catch(simulated, host);
  const known = constraint === 'UQ_users_email';
  expect(response.status).toHaveBeenCalledWith(409);
  expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'constraint-test');
  expect(response.json).toHaveBeenCalledWith({ error: { code: 'conflict', requestId: 'constraint-test',
    message: known ? 'El email ya está registrado.' : 'Conflicto con el estado del recurso.', ...(known ? { field: 'email' } : {}) } });
});
