module.exports = {
  rootDir: __dirname,
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
