import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'jest.config.js'] },
  { files: ['src/**/*.ts'], ignores: ['**/*.spec.ts'], rules: { 'no-console': 'error' } },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.spec.ts'],
    languageOptions: { globals: globals.jest },
  },
);
