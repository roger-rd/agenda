'use strict';

class PgTrapError extends Error {
  constructor() {
    super('H-PG-TRAP: Las pruebas de npm test no pueden abrir conexiones a PostgreSQL; usa npm run test:db.');
    this.name = 'PgTrapError';
  }
}

const pgPath = require.resolve('pg');
const poolPath = require.resolve('pg-pool');
const clientPath = require.resolve('pg/lib/client');

// Fábricas perezosas; el prototipo estático conserva miembros como Query.
jest.mock(clientPath, () => {
  const RealClient = jest.requireActual(clientPath);
  class TrappedClient {
    constructor() {
      throw new PgTrapError();
    }
  }
  return Object.setPrototypeOf(TrappedClient, RealClient);
});
jest.mock(poolPath, () => {
  const RealPool = jest.requireActual(poolPath);
  class TrappedPool {
    constructor() {
      throw new PgTrapError();
    }
  }
  return Object.setPrototypeOf(TrappedPool, RealPool);
});
jest.mock(pgPath, () => {
  const real = jest.requireActual(pgPath);
  // requireActual de pg carga los Client/Pool ya interceptados. No expandir
  // el objeto: copiar descriptores preserva exports sin evaluar getters.
  const descriptors = Object.getOwnPropertyDescriptors(real);
  descriptors.native = {
    configurable: true,
    enumerable: false,
    get() { throw new PgTrapError(); },
  };
  return Object.create(Object.getPrototypeOf(real), descriptors);
});

module.exports = { PgTrapError };
