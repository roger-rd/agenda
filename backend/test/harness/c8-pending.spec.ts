import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { main } from '../../scripts/harness/main.cjs';
import { C8_CONTRACT } from '../../scripts/harness/c8-contract.cjs';
import { PACKAGE_NAME, ENV_FILES, SUMMARY_PREFIX } from '../../scripts/harness/constants.cjs';
import { validateSummary } from '../../scripts/harness/summary.cjs';
import { capture } from './support/sinks';

const check: (value: unknown) => void = validateSummary;

const root = path.resolve(__dirname, '../..');
const preload = path.join(__dirname, 'support/net-trap.preload.cjs');
function run(packageRoot: string, args: string[]) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['--require', preload, 'scripts/test-db.cjs', ...args], {
    cwd: packageRoot, env: {}, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(2); expect(result.stderr).toBe('');
  expect(performance.now() - start).toBeLessThan(2000);
  const lines = result.stdout.trim().split('\n');
  expect(lines[0]).toBe('H-C8-PENDING: Contrato C8 pendiente.');
  expect(lines).toHaveLength(2); expect(lines[1].startsWith(SUMMARY_PREFIX)).toBe(true);
  const summary = JSON.parse(lines[1].slice(SUMMARY_PREFIX.length)); check(summary);
  expect(summary).toMatchObject({ mode: args.length ? 'slow' : 'fast', status: 'not_ready', exitCode: 2, code: 'H-C8-PENDING', phase: 'c8-gate' });
  const audit = JSON.parse(result.output[3] as string) as { opened: string[]; modules: string[] };
  expect(audit.opened.some(filename => /(?:^|[/\\])\.env(?:$|[.])/.test(filename))).toBe(false);
  expect(audit.modules).toEqual(['c8-contract.cjs', 'constants.cjs', 'harness-error.cjs', 'main.cjs', 'summary.cjs']);
}

describe('contrato H-C8-PENDING', () => {
  it('mantiene c8Implemented estrictamente false', () => { expect(C8_CONTRACT.c8Implemented).toBe(false); });
  it('la puerta no abre nada salvo package.json, ni crea testigo ni lanza procesos', async () => {
    const out = capture(); const err = capture(); const opened: string[] = [];
    const openSync: typeof fs.openSync = (filename, flags, mode) => {
      expect(filename).toBe(path.join(root, 'package.json')); opened.push(filename as string); return fs.openSync(filename, flags, mode);
    };
    const spawn = jest.fn(); const randomBytes = jest.fn(); const exists = jest.fn(() => false);
    const result = await main({ argv: [], cwd: root, packageRoot: root, platform: 'darwin', out: out.sink, err: err.sink,
      fs: { ...fs, openSync }, exists, spawn, randomBytes });
    expect(result).toBe(2); expect(opened).toEqual([path.join(root, 'package.json')]);
    expect(spawn).not.toHaveBeenCalled(); expect(randomBytes).not.toHaveBeenCalled(); expect(err.text()).toBe('');
    expect(out.text()).toContain('H-C8-PENDING');
    check(JSON.parse(out.text().trim().split('\n').at(-1)!.slice(SUMMARY_PREFIX.length)));
  });
  it.each([[], ['--slow']])('subproceso real con trampa de red y caché %j', (...args) => {
    const results = path.join(root, 'test-results'); const before = fs.existsSync(results);
    run(root, args); expect(fs.existsSync(results)).toBe(before);
  });
  it.each([[], ['--slow']])('copia temporal con señuelo cerrado %j', (...args) => {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-b2-gate-')));
    try {
      fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: PACKAGE_NAME }));
      fs.cpSync(path.join(root, 'scripts'), path.join(temporary, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(temporary, ENV_FILES.app), 'synthetic-decoy-only', { mode: 0o600 });
      run(temporary, args); expect(fs.existsSync(path.join(temporary, 'test-results'))).toBe(false);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it.each([['--force'], ['--slow', '--force'], ['extra']])('no permite saltar la puerta: %j', async (...args) => {
    const out = capture(); const err = capture(); const exists = jest.fn();
    expect(await main({ argv: args, cwd: root, packageRoot: root, platform: 'darwin', out: out.sink, err: err.sink, exists })).toBe(2);
    expect(err.text()).toBe('H-ARGS: Argumentos inválidos.\n'); expect(exists).not.toHaveBeenCalled();
  });
});
