import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

const passwordExceptions = [
  'src/database/data-source-options.ts',
  'src/config/database-credentials.ts',
  'src/database/data-source-options.spec.ts',
  'src/config/database-credentials.spec.ts',
  'src/config/app.config.spec.ts',
];
const trapExceptions = ['test/harness/pg-trap.setup.cjs', 'test/harness/pg-trap.spec.ts'];
const passwordSyntax = [{
  selector: "Literal[value='revealPassword']",
  message: 'revealPassword solo está permitido en los archivos autorizados.',
}];
// eslint-disable-next-line no-restricted-syntax
const passwordProperties = [{ property: 'revealPassword', message: 'Acceso reservado a credenciales.' }];
const trapSyntax = [{
  selector: "CallExpression[callee.object.name='jest'][callee.property.name=/^(unmock|dontMock|doUnmock|requireActual|requireMock|createMockFromModule)$/][arguments.0.type='Literal'][arguments.0.value=/^(pg$|pg-pool$|pg\\u002F)/]",
  message: 'No se permite evadir la trampa de pg.',
}];
const harnessSyntax = [{
  selector: "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/(test\\u002Fharness|scripts\\u002Fharness|test\\u002Fdb)/]",
  message: 'src no puede importar el arnés de pruebas.',
}];

// Particiones disjuntas: ESLint reemplaza estas listas, no las concatena.
const restrictionBlocks = [true, false].flatMap(password =>
  [true, false].flatMap(trap => [true, false].map(source => ({
    files: (password ? ['**/*.{ts,cjs,mjs}'] : passwordExceptions).flatMap(p =>
      (trap ? ['**/*'] : trapExceptions).map(t =>
        [p, t, ...(source ? ['src/**'] : [])])),
    ignores: [...(password ? passwordExceptions : []), ...(trap ? trapExceptions : []),
      ...(source ? [] : ['src/**'])],
    rules: {
      'no-restricted-properties': ['error', ...(password ? passwordProperties : [])],
      'no-restricted-syntax': ['error', ...(password ? passwordSyntax : []),
        ...(trap ? trapSyntax : []), ...(source ? harnessSyntax : [])],
      ...(source ? { 'no-restricted-imports': ['error', { patterns: [{
        regex: '(test/harness|scripts/harness|test/db)',
        message: 'src no puede importar el arnés de pruebas.',
      }] }] } : {}),
    },
  }))),

);

export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'jest.config.js', 'jest.db.config.js'] },
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
  { files: ['**/*.cjs'], languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['test/harness/**/*.cjs'], languageOptions: { globals: globals.jest } },
  ...restrictionBlocks,
);
