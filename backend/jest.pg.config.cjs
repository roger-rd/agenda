module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/pg/**/*.pg.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
  setupFiles: ['<rootDir>/test/pg/support/pg-setup.cjs'],
  testTimeout: 60000,
};
