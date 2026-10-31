import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

type Sample = { file: string; code: string };
type Message = { ruleId: string | null; severity: number };
function lint(samples: Sample[]): Message[][] {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const { ESLint } = require('eslint');
    const fs = require('node:fs');
    (async () => {
      const eslint = new ESLint();
      const samples = JSON.parse(fs.readFileSync(0, 'utf8'));
      const results = [];
      for (const { file, code } of samples) {
        const [result] = await eslint.lintText(code, { filePath: file });
        results.push(result.messages);
      }
      process.stdout.write(JSON.stringify(results));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: resolve(__dirname, '../..'), input: JSON.stringify(samples),
    encoding: 'utf8', timeout: 30000 }));
}

const exceptions = ['src/database/data-source-options.ts', 'src/config/database-credentials.ts',
  'src/database/data-source-options.spec.ts', 'src/config/database-credentials.spec.ts', 'src/config/app.config.spec.ts'];

test('revealPassword: propiedad y literal prohibidos con cinco excepciones exactas', () => {
  const code = "const value = { revealPassword() {} }; value.revealPassword(); value['revealPassword']();";
  const results = lint(['src/foo.ts', 'test/harness/foo.spec.ts', 'scripts/foo.cjs', 'foo.mjs', ...exceptions]
    .map(file => ({ file, code })));
  for (const messages of results.slice(0, 4)) {
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-properties', severity: 2 }),
      expect.objectContaining({ ruleId: 'no-restricted-syntax', severity: 2 }),
    ]));
  }
  for (const messages of results.slice(4)) expect(messages).toEqual([]);
});

test('evadir pg se prohíbe para todos los métodos y rutas; excepciones acotadas', () => {
  const methods = ['unmock', 'dontMock', 'doUnmock', 'requireActual', 'requireMock', 'createMockFromModule'];
  const code = methods.flatMap(method => ['pg', 'pg-pool', 'pg/lib/client']
    .map(name => `jest.${method}('${name}');`)).join('\n');
  const [spec, setup, trap, exception] = lint([
    { file: 'src/foo.spec.ts', code }, { file: 'test/harness/pg-trap.setup.cjs', code },
    { file: 'test/harness/pg-trap.spec.ts', code }, { file: exceptions[2], code },
  ]);
  for (const messages of [spec, exception]) {
    expect(messages).toHaveLength(18);
    expect(messages.every(message => message.ruleId === 'no-restricted-syntax' && message.severity === 2)).toBe(true);
  }
  expect(setup).toEqual([]);
  expect(trap).toEqual([]);
});

test('src no puede importar ni requerir el arnés y conserva no-console', () => {
  const code = "import '../test/harness/foo'; import '../scripts/harness/foo'; import '../test/db/foo'; require('../test/harness/foo');";
  const [source, tests, scripts, configuration, exception] = lint([
    { file: 'src/foo.ts', code }, { file: 'test/harness/foo.spec.ts', code: "import '../test/harness/foo';" },
    { file: 'scripts/foo.cjs', code: "require('../test/harness/foo');" },
    { file: 'foo.mjs', code: "import './test/harness/foo';" },
    { file: exceptions[0], code: "import '../test/harness/foo'; console.log('x');" },
  ]);
  expect(source.filter(message => message.ruleId === 'no-restricted-imports')).toHaveLength(3);
  expect(source.some(message => message.ruleId === 'no-restricted-syntax')).toBe(true);
  for (const messages of [tests, scripts, configuration]) expect(messages).toEqual([]);
  expect(exception.map(message => message.ruleId).sort()).toEqual(['no-console', 'no-restricted-imports']);
});

test('CommonJS, globales Jest del setup y código benigno sin errores', () => {
  const results = lint([
    { file: 'scripts/example.cjs', code: "module.exports = require('node:path').sep;" },
    { file: 'test/harness/example.cjs', code: "jest.mock('example'); module.exports = require('node:path').sep;" },
    { file: 'src/foo.ts', code: 'export const value = 1;' },
    { file: 'src/foo.spec.ts', code: "jest.mock('pg'); jest.unmock('pg-other');" },
  ]);
  for (const messages of results) expect(messages).toEqual([]);
});
