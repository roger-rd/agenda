/* eslint-disable @typescript-eslint/no-require-imports -- Se inspeccionan configuraciones CommonJS. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScriptTransformer } from '@jest/transform';
import { readConfigs } from 'jest-config';

const root = resolve(__dirname, '../..');
const config = require('../../jest.config.js');
const dbConfig = require('../../jest.db.config.js');
const readJson = (name: string) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));

test('configuración unitaria exacta y transformaciones independientes por proyecto', async () => {
  expect(config.rootDir).toBe(root);
  expect(config.projects).toHaveLength(2);
  const expectedProjects = [
    { name: 'src', testMatch: '<rootDir>/src/**/*.spec.ts', tsconfig: 'tsconfig.json',
      files: ['src/main.ts', 'src/database/errors/database-failure.spec.ts'] },
    { name: 'harness', testMatch: '<rootDir>/test/harness/**/*.spec.ts', tsconfig: 'tsconfig.test.json',
      files: ['test/harness/pg-trap.spec.ts'] },
  ];
  expect(config.projects[0]).not.toBe(config.projects[1]);
  expect(config.projects[0].transform).not.toBe(config.projects[1].transform);
  expect(config.projects[0].setupFiles).not.toBe(config.projects[1].setupFiles);
  // Consultar al transformador real de Jest para cada configuración de proyecto.
  const { configs } = await readConfigs({ $0: 'jest', _: [], config: resolve(root, 'jest.config.js') }, [root]);
  expect(configs).toHaveLength(2);
  for (const [i, expected] of expectedProjects.entries()) {
    expect(config.projects[i]).toEqual({
      displayName: expected.name,
      rootDir: root,
      testEnvironment: 'node',
      testMatch: [expected.testMatch],
      setupFiles: ['<rootDir>/test/harness/pg-trap.setup.cjs'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: `<rootDir>/${expected.tsconfig}` }] },
    });
    expect(config.projects[i].setupFiles[0]).toBe('<rootDir>/test/harness/pg-trap.setup.cjs');
    expect(configs[i].displayName?.name).toBe(expected.name);
    const transformer = await createScriptTransformer(configs[i]);
    for (const file of expected.files) {
      const selected = Reflect.get(transformer, '_getTransformPatternAndPath').call(transformer, resolve(root, file));
      const actual = configs[i].transform.find(([pattern]) => pattern === selected[0]);
      expect(actual?.[2]).toEqual({ tsconfig: `<rootDir>/${expected.tsconfig}` });
    }
  }
});

test('configuración DB aislada y tsconfig de pruebas', () => {
  expect(dbConfig).toEqual({ rootDir: root, testMatch: ['<rootDir>/test/db/**/*.db.spec.ts'],
    testEnvironment: 'node', transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] } });
  expect(dbConfig).not.toHaveProperty('setupFiles');
  expect(dbConfig).not.toHaveProperty('globalSetup');
  expect(JSON.stringify(dbConfig)).not.toContain('pg-trap');
  expect(readJson('tsconfig.test.json')).toEqual({ extends: './tsconfig.json',
    compilerOptions: { rootDir: '.', allowJs: true, checkJs: true, noEmit: true },
    include: ['src/**/*.ts', 'test/**/*.ts', 'test/**/*.cjs', 'scripts/**/*.cjs'], exclude: ['dist', 'node_modules'] });
});

test('scripts npm exactos', () => {
  expect(readJson('package.json').scripts).toMatchObject({
    test: 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js',
    'test:db': 'node scripts/test-db.cjs', 'test:db:slow': 'node scripts/test-db.cjs --slow',
    typecheck: 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json',
    build: 'nest build -p tsconfig.build.json', lint: 'eslint . --max-warnings 0',
  });
});

test('listTests incluye el arnés, excluye DB y la configuración DB lista cero archivos', () => {
  const list = (name: string): string[] => JSON.parse(execFileSync(process.execPath,
    ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--listTests', '--config', name, '--json', '--runInBand'],
    { cwd: root, encoding: 'utf8', timeout: 30000 }));
  const files = list('jest.config.js');
  expect(files.some(file => file.includes('/test/harness/'))).toBe(true);
  expect(files.some(file => file.includes('/test/db/'))).toBe(false);
  expect(list('jest.db.config.js')).toEqual([]);
}, 65000);
