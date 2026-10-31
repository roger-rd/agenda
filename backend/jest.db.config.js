module.exports = {
  rootDir: __dirname,
  testMatch: ['<rootDir>/test/db/**/*.db.spec.ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
