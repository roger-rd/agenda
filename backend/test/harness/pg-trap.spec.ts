/* eslint-disable @typescript-eslint/no-require-imports -- Se comprueba la carga CommonJS interceptada por Jest. */
import * as pg from 'pg';
import { DataSource } from 'typeorm';
import { Socket } from 'node:net';
import { PgTrapError } from './pg-trap.setup.cjs';

const secret = 'PASSWORD_SINTETICA_H_TRAP_719';
const options = { host: 'HOST_SINTETICO', user: 'USER_SINTETICO', password: secret };
function trapped(action: () => unknown): void {
  expect(action).toThrow(/^H-PG-TRAP:/);
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('PgTrapError');
    for (const value of Object.values(options)) expect((error as Error).message).not.toContain(value);
  }
}

test('setupFiles intercepta imports estáticos, constructores y subclases antes de cargar el spec', () => {
  trapped(() => new pg.Pool(options));
  trapped(() => new pg.Client(options));
  expect(() => new pg.Client()).toThrow(PgTrapError);
  class DerivedPool extends pg.Pool {}
  trapped(() => new DerivedPool(options));
  trapped(() => pg.native);
});

test('las rutas directas de Pool y Client también lanzan', () => {
  const Pool = require('pg-pool');
  const Client = require('pg/lib/client');
  trapped(() => new Pool(options));
  trapped(() => new Client(options));
});

test('conserva los exports reales y la resolución física de pg', () => {
  const real = jest.requireActual<typeof pg>('pg');
  const error = new pg.DatabaseError('sintético', 1, 'error');
  error.code = '23505';
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(real.DatabaseError);
  expect(error.code).toBe('23505');
  for (const key of Object.keys(real).filter(key => !['Pool', 'Client'].includes(key))) {
    expect(Reflect.get(pg, key)).toBe(Reflect.get(real, key));
  }
  expect(pg.types.getTypeParser(23)('42')).toBe(42);
  expect(pg.defaults).toBe(real.defaults);
  expect(pg.escapeIdentifier('a"b')).toBe('"a""b"');
  expect(pg.escapeLiteral("a'b")).toBe("'a''b'");
  expect(require.resolve('pg')).toMatch(/node_modules\/pg\/lib\/index\.js$/);
  expect(require.resolve('pg')).not.toContain('pg-trap.setup');
});

test('los mocks explícitos sobreviven a resetModules e isolateModules', () => {
  jest.resetModules();
  trapped(() => new (require('pg').Pool)(options));
  trapped(() => new (require('pg').Client)(options));
  jest.isolateModules(() => {
    trapped(() => new (require('pg').Pool)(options));
    trapped(() => new (require('pg').Client)(options));
    trapped(() => new (require('pg-pool'))(options));
    trapped(() => new (require('pg/lib/client'))(options));
  });
});

test('TypeORM carga la trampa y rechaza initialize sin conectar sockets', async () => {
  const connect = jest.spyOn(Socket.prototype, 'connect');
  try {
    const ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port: 1,
      username: 'u', password: secret, database: 'd' });
    expect(Reflect.get(ds.driver, 'postgres')).toBe(require('pg'));
    await expect(ds.initialize()).rejects.toThrow(/^H-PG-TRAP:/);
    expect(connect).not.toHaveBeenCalled();
    expect(ds.isInitialized).toBe(false);
    // El mismo constructor usado por initialize no revela opciones.
    trapped(() => new (Reflect.get(ds.driver, 'postgres').Pool)(options));
  } finally { connect.mockRestore(); }
});
