import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { main, internalFailure, terminateNow } from '../../scripts/harness/main.cjs';
import type { Dependencies } from '../../scripts/harness/main.cjs';
import { CATALOG } from '../../scripts/harness/harness-error.cjs';
import { PACKAGE_NAME, SUMMARY_PREFIX } from '../../scripts/harness/constants.cjs';
import { buildSummary, validateSummary, formatSummaryLine } from '../../scripts/harness/summary.cjs';
import type { Summary } from '../../scripts/harness/summary.cjs';
import { fixture } from './support/env-fixtures';
import { capture } from './support/sinks';
import { APP_SECRET, OWNER_SECRET } from './support/synthetic-secrets';

const check: (value: unknown) => void = validateSummary;
const root = path.resolve(__dirname, '../..');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function setup() {
  const f = fixture();
  const packageRoot = fs.realpathSync(f.root);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: PACKAGE_NAME }));
  f.write('app'); f.write('owner');
  const out = capture(); const err = capture();
  const signals = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: 24680, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
  let alive = false;
  const killGroup = jest.fn(() => { alive = false; });
  const spawn = jest.fn(() => child);
  const opened: string[] = [];
  const openSync: typeof fs.openSync = (filename, flags, mode) => {
    if (typeof filename !== 'string' || !filename.startsWith(packageRoot + path.sep)) throw new Error('Outside synthetic package');
    opened.push(filename); return fs.openSync(filename, flags, mode);
  };
  const deps: Dependencies = { argv: [], cwd: packageRoot, packageRoot, platform: 'darwin', out: out.sink, err: err.sink,
    fs: { ...fs, openSync }, signals, getuid: () => process.getuid!(), now: Date.now,
    randomBytes: size => Buffer.alloc(size, 1), spawn: spawn as unknown as typeof nodeSpawn,
    killGroup, isGroupAlive: () => alive, graceMs: 10, postKillWaitMs: 20, watchdogMs: 500,
  };
  return { f, deps, out, err, signals, child, spawn, killGroup, opened,
    ready: () => { deps.isReady = () => ({ ready: true, missing: [] }); },
    setAlive: (value: boolean) => { alive = value; },
    isAlive: () => alive,
    exit: (code = 0) => { alive = false; child.stdout!.push(null); child.stderr!.push(null); child.emit('exit', code, null); },
    summary: (): Summary => {
      const lines = out.text().trim().split('\n');
      const last = lines.at(-1)!;
      expect(last.startsWith(SUMMARY_PREFIX)).toBe(true);
      const value: unknown = JSON.parse(last.slice(SUMMARY_PREFIX.length)); check(value);
      expect(lines.filter(line => line.startsWith(SUMMARY_PREFIX))).toHaveLength(1);
      return value as Summary;
    },
    cleanup: () => { child.stdout!.destroy(); child.stderr!.destroy(); f.cleanup(); },
  };
}

function hostileValues() {
  const touched = jest.fn(() => { throw new Error(APP_SECRET); });
  const hostile = Object.create(null, {
    message: { get: touched }, stack: { get: touched }, cause: { get: touched },
    toString: { value: touched }, toJSON: { value: touched },
  });
  const proxy = new Proxy({}, { get: touched, getPrototypeOf: touched });
  return { touched, values: [APP_SECRET, Symbol(APP_SECRET), null, Object.create(null),
    new Error(APP_SECRET, { cause: new Error(OWNER_SECRET) }), hostile, proxy] as unknown[] };
}

describe('main: secuencia, puerta y ejecución simulada', () => {
  it.each([[], ['--slow']])('puerta cerrada %j solo abre package.json', async (...args) => {
    const s = setup();
    try {
      const randomBytes = jest.fn(); s.deps.randomBytes = randomBytes; s.deps.argv = args;
      expect(await main(s.deps)).toBe(2);
      expect(s.opened).toEqual([path.join(s.deps.packageRoot, 'package.json')]);
      expect(s.spawn).not.toHaveBeenCalled(); expect(randomBytes).not.toHaveBeenCalled();
      expect(s.err.text()).toBe('');
      expect(s.out.text().split('\n')[0]).toBe('H-C8-PENDING: Contrato C8 pendiente.');
      expect(s.summary()).toMatchObject({ code: 'H-C8-PENDING', phase: 'c8-gate', mode: args.length ? 'slow' : 'fast' });
    } finally { s.cleanup(); }
  });
  it.each([['--force'], ['--slow', 'extra'], ['--slow', '--slow'], ['--help']])('rechaza argumentos %j antes de plataforma y fs', async (...args) => {
    const s = setup();
    try {
      s.deps.argv = args; s.deps.platform = 'win32';
      expect(await main(s.deps)).toBe(2); expect(s.opened).toEqual([]);
      expect(s.summary()).toMatchObject({ code: 'H-ARGS', phase: 'args' }); expect(s.spawn).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it('rechaza plataforma antes de leer paquete', async () => {
    const s = setup();
    try { s.deps.platform = 'win32'; expect(await main(s.deps)).toBe(2); expect(s.opened).toEqual([]); expect(s.summary().code).toBe('H-PLATFORM'); }
    finally { s.cleanup(); }
  });
  it.each(['cwd', 'name', 'oversize', 'json'])('rechaza paquete inválido: %s', async kind => {
    const s = setup();
    try {
      if (kind === 'cwd') s.deps.cwd = root;
      else fs.writeFileSync(path.join(s.deps.packageRoot, 'package.json'), kind === 'name' ? '{"name":"wrong"}' : kind === 'oversize' ? ' '.repeat(65537) : '{');
      expect(await main(s.deps)).toBe(2); expect(s.summary()).toMatchObject({ code: 'H-PACKAGE', phase: 'package' });
      expect(s.spawn).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it.each([false, true])('flujo listo simulado: comando exacto, entorno cerrado y resumen final; slow=%s', async slow => {
    const s = setup();
    try {
      s.ready(); s.deps.argv = slow ? ['--slow'] : [];
      const pending = main(s.deps);
      expect(s.spawn).toHaveBeenCalledTimes(1);
      const call = (s.spawn.mock.calls as unknown as Parameters<typeof nodeSpawn>[])[0];
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual(['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'jest.db.config.js', '--runInBand', '--testTimeout', '30000', ...(slow ? ['--testNamePattern', '\\[slow\\]'] : [])]);
      const options = call[2]!;
      expect(options).toMatchObject({ cwd: s.deps.packageRoot, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(Object.keys(options.env!).sort()).toEqual(['AGENDA_DB_TEST_TOKEN', 'NODE_ENV', 'NO_COLOR', 'PGPASSFILE']);
      expect(JSON.stringify(options.env)).not.toContain(APP_SECRET);
      s.child.stdout!.emit('data', Buffer.from(APP_SECRET + '!')); s.child.stderr!.emit('data', Buffer.from(OWNER_SECRET + '!'));
      s.exit(); expect(await pending).toBe(0);
      expect(s.out.text()).toContain('[REDACTED]!'); expect(s.err.text()).toBe('[REDACTED]!');
      expect(s.summary()).toMatchObject({ status: 'ok', exitCode: 0, code: null, mode: slow ? 'slow' : 'fast' });
      expect(s.signals.eventNames()).toEqual([]);
    } finally { s.cleanup(); }
  });
  it('traduce fallo B1 como precondición en fase env', async () => {
    const s = setup();
    try {
      s.ready(); fs.chmodSync(s.f.filename('app'), 0o644);
      expect(await main(s.deps)).toBe(2); expect(s.spawn).not.toHaveBeenCalled();
      expect(s.summary()).toMatchObject({ code: 'H-ENV-PERM', phase: 'env', exitCode: 2 });
    } finally { s.cleanup(); }
  });
  it('escanea test-results sintético después del hijo', async () => {
    const s = setup();
    try {
      s.ready(); const results = path.join(s.deps.packageRoot, 'test-results'); fs.mkdirSync(results);
      fs.writeFileSync(path.join(results, 'artifact'), APP_SECRET);
      const pending = main(s.deps); s.exit();
      expect(await pending).toBe(4); expect(s.summary()).toMatchObject({ code: 'H-SCAN-HIT', phase: 'cleanup' });
      expect(s.out.text() + s.err.text()).not.toContain(APP_SECRET);
    } finally { s.cleanup(); }
  });
});

describe('main: pruebas de fallos internos para revisión UN-R6', () => {
  it('F2 require perezoso tras la puerta simulada falla con W-1 y 4 sin eco', async () => {
    const s = setup(); const { values, touched } = hostileValues();
    const filename = path.join(root, 'scripts/harness/main.cjs'); const localRequire = createRequire(filename);
    try {
      s.ready();
      const module = { exports: {} as { main: typeof main } };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, TextDecoder,
        require: (name: string) => { if (name === './env-files.cjs') throw values.at(-1); return localRequire(name); } });
      expect(await module.exports.main(s.deps)).toBe(4);
      expect(s.err.text()).toBe('W-1: Fallo interno del envoltorio.\n');
      expect(s.summary()).toMatchObject({ code: 'W-1', exitCode: 4, phase: 'internal' });
      expect(s.spawn).not.toHaveBeenCalled(); expect(touched).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it.each(['clock', 'gate', 'token'])('W-1 no inspecciona ni imprime valores hostiles en %s', async origin => {
    const { values, touched } = hostileValues();
    for (const thrown of values) {
      const s = setup();
      try {
        if (origin === 'clock') s.deps.now = () => { throw thrown; };
        if (origin === 'gate') s.deps.isReady = () => { throw thrown; };
        if (origin === 'token') { s.ready(); s.deps.randomBytes = () => { throw thrown; }; }
        expect(await main(s.deps)).toBe(4);
        expect(s.err.text()).toBe('W-1: Fallo interno del envoltorio.\n');
        expect(s.summary()).toMatchObject({ code: 'W-1', phase: 'internal', status: 'error', exitCode: 4 });
        expect(s.out.text().trim().split('\n')).toHaveLength(1);
        expect(s.out.text() + s.err.text()).not.toContain(APP_SECRET);
        expect(s.out.text() + s.err.text()).not.toContain(OWNER_SECRET);
      } finally { s.cleanup(); }
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it('W-2 mapea fallos de spawn sin conservar los valores lanzados', async () => {
    const { values, touched } = hostileValues();
    for (const thrown of values) {
      const s = setup();
      try {
        s.ready(); s.spawn.mockImplementation(() => { throw thrown; });
        expect(await main(s.deps)).toBe(4);
        expect(s.err.text()).toBe('W-2: Fallo interno del envoltorio.\n');
        expect(s.summary()).toMatchObject({ code: 'W-2', phase: 'internal', exitCode: 4 });
        expect(s.out.text() + s.err.text()).not.toContain(APP_SECRET);
      } finally { s.cleanup(); }
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it('W-2 termina un grupo existente si falla el supervisor', async () => {
    const s = setup(); const { values, touched } = hostileValues();
    try {
      s.ready(); s.setAlive(true);
      const pending = main(s.deps); s.child.emit('error', values.at(-1));
      expect(await pending).toBe(4);
      expect(s.killGroup).toHaveBeenCalledWith(24680, 'SIGKILL');
      expect(s.err.text()).toBe('W-2: Fallo interno del envoltorio.\n');
      expect(s.summary().code).toBe('W-2'); expect(touched).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it.each(['throw', 'invalid'])('W-3 ante resumen %s: diagnóstico exclusivo y resumen válido de emergencia', async kind => {
    const { values, touched } = hostileValues();
    for (const thrown of values) {
      const s = setup();
      try {
        s.deps.summaryBuilder = kind === 'throw' ? () => { throw thrown; } : () => ({ invalid: true } as unknown as Summary);
        expect(await main(s.deps)).toBe(4);
        expect(s.err.text()).toBe('W-3: Fallo interno del envoltorio.\n');
        expect(s.out.text().trim().split('\n')).toHaveLength(1);
        expect(s.summary()).toMatchObject({ code: 'W-3', exitCode: 4, phase: 'internal' });
        expect(s.out.text()).not.toContain(APP_SECRET);
      } finally { s.cleanup(); }
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it.each(['W-1', 'W-3', 'W-4'] as const)('F3 %s termina el grupo inmediatamente, sin esperar watchdog', async code => {
    const s = setup();
    let pending: Promise<number> | undefined;
    jest.useFakeTimers();
    try {
      s.ready(); s.setAlive(true); pending = main(s.deps);
      expect(s.spawn).toHaveBeenCalledTimes(1); expect(s.isAlive()).toBe(true);
      expect(await internalFailure(code, s.deps)).toBe(4);
      // Antes de avanzar un solo temporizador: el watchdog no puede salvar la mutación.
      expect(s.killGroup.mock.calls).toEqual([[24680, 'SIGKILL']]);
      expect(s.isAlive()).toBe(false); expect(await pending).toBe(4);
      expect(s.err.text()).toBe(`${code}: ${CATALOG[code]}\n`);
      expect(s.summary()).toMatchObject({ code, exitCode: 4, phase: 'internal' });
      expect(s.out.text() + s.err.text()).not.toContain(APP_SECRET);
      expect(jest.getTimerCount()).toBe(0);
    } finally { terminateNow(); if (pending) await pending; jest.useRealTimers(); s.cleanup(); }
  });
  it('W-1 termina un grupo activo al rechazar una dependencia asíncrona', async () => {
    const s = setup(); const { values, touched } = hostileValues();
    try {
      s.ready(); s.setAlive(true);
      const pending = main(s.deps);
      const failingDeps: Dependencies = { ...s.deps, argv: ['--force'], out: s.out.sink,
        err: { emit: () => false, drain: async () => { throw values.at(-1); } } };
      expect(await main(failingDeps)).toBe(4);
      await pending;
      expect(s.killGroup).toHaveBeenCalledWith(24680, 'SIGKILL'); expect(touched).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
});

describe('test-db: entrada fina', () => {
  it.each(['main', 'constants', 'summary', 'harness-error', 'initialization'])('F2 carga/inicialización %s falla cerrado en subproceso real para ambos modos', target => {
    for (const mode of ['fast', 'slow']) {
      const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'support/load-failure.preload.cjs'),
        'scripts/test-db.cjs', ...(mode === 'slow' ? ['--slow'] : []), target], {
        cwd: root, env: {}, shell: false, encoding: 'utf8', timeout: 3000,
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(4);
      expect(result.stderr).toBe('W-1: Fallo interno del envoltorio.\n');
      expect(result.stdout).toBe(formatSummaryLine(buildSummary({ mode, status: 'error', exitCode: 4, code: 'W-1', phase: 'internal', durationMs: 0 })) + '\n');
      expect(result.stdout + result.stderr).not.toContain('SYN-Initial-Load-Secret42');
      expect(result.stdout + result.stderr).not.toContain(root);
    }
  });
  it('F2 constantes literales de emergencia coinciden con catálogo y resumen en ambos modos', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/test-db.cjs'), 'utf8');
    const ast = ts.createSourceFile('test-db.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const literals: Record<string, string> = {};
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) literals[node.name.text] = node.initializer.text;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(literals.INITIAL_DIAGNOSTIC).toBe(`W-1: ${CATALOG['W-1']}\n`);
    for (const mode of ['fast', 'slow']) {
      expect(literals[mode === 'fast' ? 'INITIAL_FAST' : 'INITIAL_SLOW']).toBe(formatSummaryLine(buildSummary({ mode, status: 'error', exitCode: 4, code: 'W-1', phase: 'internal', durationMs: 0 })) + '\n');
    }
  });
  it('AST prohíbe entorno, child_process, console y escrituras distintas de stdout/stderr', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/test-db.cjs'), 'utf8');
    const ast = ts.createSourceFile('test-db.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const hits: string[] = [];
    const forbidden = /^(?:writeFile|writev|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|chmod|fchmod|chown|fchown|truncate|ftruncate|copyFile|cp|link|symlink|utimes|futimes)(?:Sync)?$/;
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        if (forbidden.test(node.text) || node.text === 'console' || /^(?:node:)?child_process$/.test(node.text)) hits.push(node.text);
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'process' && ['env', 'exit'].includes(node.name.text)) hits.push(node.getText(ast));
      if (ts.isElementAccessExpression(node) && node.expression.getText(ast) === 'process') hits.push(node.getText(ast));
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'write') expect(node.expression.getText(ast)).toBe('stream');
      ts.forEachChild(node, visit);
    }
    visit(ast); expect(hits).toEqual([]);
    expect(source).toContain('out: sink(process.stdout), err: sink(process.stderr)');
  });
  it.each(['uncaughtException', 'unhandledRejection'])('%s emite W-4 sin inspeccionar el valor', async event => {
    const filename = path.join(root, 'scripts/test-db.cjs');
    const localRequire = createRequire(filename); const { values, touched } = hostileValues();
    const signals = Object.assign(new EventEmitter(), { argv: ['node', filename], cwd: () => root, platform: 'darwin',
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: undefined as number | undefined });
    let stdout = ''; let stderr = '';
    signals.stdout.on('data', chunk => { stdout += chunk.toString(); }); signals.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const fatal = jest.fn(internalFailure);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { __dirname: path.dirname(filename), process: signals, Buffer,
      require: (name: string) => name === './harness/main.cjs' ? { main: () => new Promise(() => {}), internalFailure: fatal } : localRequire(name) });
    for (const value of values) signals.emit(event, value);
    await tick();
    expect(fatal).toHaveBeenCalledTimes(1); expect(signals.exitCode).toBe(4);
    expect(stderr).toBe('W-4: Fallo interno del envoltorio.\n');
    const summary: unknown = JSON.parse(stdout.trim().slice(SUMMARY_PREFIX.length)); check(summary);
    expect(summary).toEqual(buildSummary({ mode: 'fast', status: 'error', exitCode: 4, code: 'W-4', phase: 'internal', durationMs: 0 }));
    expect(touched).not.toHaveBeenCalled();
  });
});
