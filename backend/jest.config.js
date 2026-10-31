module.exports = {
  rootDir: __dirname,
  projects: [
    {
      displayName: 'src',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/harness/pg-trap.setup.cjs'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
      },
    },
    {
      displayName: 'harness',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/harness/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/harness/pg-trap.setup.cjs'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
      },
    },
  ],
};
