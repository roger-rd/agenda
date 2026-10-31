import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';

// B1 no tiene excepciones. B2 deberá revisar expresamente esta tabla.
const ALLOW: Readonly<Record<string, readonly string[]>> = Object.freeze({});
const directory = path.resolve(__dirname, '../../scripts/harness');
const modules = fs.readdirSync(directory).filter(name => name.endsWith('.cjs')).sort();
const newSpecs = ['constants', 'harness-error', 'c8-contract', 'run-token', 'child-env',
  'env-files', 'validators-drift', 'summary', 'static-guards'];

function staticViolations(source: string): string[] {
  const ast = ts.createSourceFile('module.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits = new Set<string>();
  const writes = /^(?:write(?:File|v)?|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|chmod|fchmod|chown|fchown|truncate|ftruncate|copyFile|cp|link|symlink|utimes|futimes)(?:Sync)?$/;
  const forbiddenModule = /^(?:node:)?(?:child_process|net|http|https|http2|dns|tls|dgram)(?:\/|$)/;
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && forbiddenModule.test(node.text)) hits.add('forbidden-module');
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      const name = node.text;
      // Inspecciona también referencias y destructuring, no solo llamadas directas.
      if (writes.test(name)) hits.add('fs-write');
      if (name === 'console') hits.add('console');
      if (name === 'eval' || name === 'Function') hits.add('dynamic-code');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text :
        node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (node.expression.getText(ast) === 'process' && (property === 'env' || property === undefined)) hits.add('process-env');
    }
    if (ts.isVariableDeclaration(node) && node.initializer?.getText(ast) === 'process') {
      // No se permiten aliases del proceso; evita eludir la comprobación con destructuring.
      hits.add('process-env');
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text :
        ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
      if (name === 'open' || name === 'openSync') {
        const flags = node.arguments[1]?.getText(ast) ?? '';
        const pieces = flags.split('|').map(value => value.trim());
        if (pieces.length !== 3 || !['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK'].every(value => pieces.includes(value))) hits.add('fs-open-flags');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...hits].sort();
}

function envReferences(source: string): string[] {
  const ast = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && /(?:^|[/\\])\.env(?:$|[./\\])/.test(node.text)) hits.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return hits;
}

describe('guardas estáticas B1', () => {
  it('mantiene ALLOW vacío y solo los siete módulos autorizados', () => {
    expect(ALLOW).toEqual({});
    expect(modules).toEqual(['c8-contract.cjs', 'child-env.cjs', 'constants.cjs', 'env-files.cjs',
      'harness-error.cjs', 'run-token.cjs', 'summary.cjs']);
  });
  it.each(modules)('%s no usa APIs prohibidas', name => {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    expect(source.startsWith("'use strict';")).toBe(true);
    expect(staticViolations(source).filter(hit => !(ALLOW[name] ?? []).includes(hit))).toEqual([]);
  });
  it.each([
    ['process . env', 'process-env'], ['process["env"]', 'process-env'], ['const {env} = process', 'process-env'],
    ['const p = process; p.env', 'process-env'], ['require("child_process")', 'forbidden-module'],
    ['require("node:net")', 'forbidden-module'], ['require("node:http")', 'forbidden-module'],
    ['require("node:https")', 'forbidden-module'], ['require("node:dns/promises")', 'forbidden-module'],
    ['require("node:tls")', 'forbidden-module'], ['require("node:dgram")', 'forbidden-module'],
    ['fs["writeFileSync"](p, x)', 'fs-write'], ['const {unlink: remove} = fs', 'fs-write'],
    ['fs.appendFile(p, x)', 'fs-write'], ['fs.mkdir(p)', 'fs-write'], ['fs.rm(p)', 'fs-write'],
    ['fs.rename(a,b)', 'fs-write'], ['fs.chmod(p, 1)', 'fs-write'], ['fs.createWriteStream(p)', 'fs-write'],
    ['fs.openSync(p, "w")', 'fs-open-flags'], ['fs.open(p, O_WRONLY)', 'fs-open-flags'],
    ['console.log(x)', 'console'], ['console["log"](x)', 'console'], ['eval(x)', 'dynamic-code'],
    ['new Function(x)', 'dynamic-code'],
  ])('detecta una mutación prohibida %#', (source, hit) => {
    expect(staticViolations(source)).toContain(hit);
  });
  it.each(modules)('%s congela exports y no hace I/O al cargar', name => {
    const filename = path.join(directory, name);
    const source = fs.readFileSync(filename, 'utf8');
    const localRequire = createRequire(filename);
    const io = jest.fn(() => { throw new Error('I/O durante carga'); });
    const module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(source, {
      module, Buffer, TextDecoder,
      process: new Proxy({}, { get: io }),
      require: (specifier: string) => specifier === 'node:fs' ? new Proxy({}, { get: io }) : localRequire(specifier),
    });
    expect(io).not.toHaveBeenCalled();
    expect(Object.isFrozen(module.exports)).toBe(true);
    for (const value of Object.values(module.exports)) {
      if (value && typeof value === 'object') expect(Object.isFrozen(value)).toBe(true);
    }
  });
  it.each(newSpecs.filter(name => name !== 'constants'))('%s no referencia nombres de entornos reales', name => {
    const source = fs.readFileSync(path.join(__dirname, `${name}.spec.ts`), 'utf8');
    expect(envReferences(source)).toEqual([]);
  });
  it('detecta rutas sensibles como literales; las fixtures temporales y constantes son las únicas excepciones', () => {
    const app = '/package/' + ['.', 'env', '.', 'test'].join('');
    const infra = '../infra/' + ['.', 'env'].join('');
    expect(envReferences(`readFileSync('${app}')`)).toEqual([app]);
    expect(envReferences(`readFileSync('${infra}')`)).toEqual([infra]);
  });
});
