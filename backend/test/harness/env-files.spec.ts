import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect, parseEnv } from 'node:util';
import { parseStrictEnv, readEnvFile, readEnvFiles } from '../../scripts/harness/env-files.cjs';
import { ENV_FILES, KNOWN_ENV_KEYS } from '../../scripts/harness/constants.cjs';
import { HarnessError } from '../../scripts/harness/harness-error.cjs';
import { envText, fixture, parseCorpus } from './support/env-fixtures';
import { APP_SECRET, OWNER_SECRET, THIRD_PARTY_SECRET } from './support/synthetic-secrets';

function expectCode(action: () => unknown, code: string) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HarnessError);
  expect(error).toMatchObject({ code });
  for (const secret of [APP_SECRET, OWNER_SECRET, THIRD_PARTY_SECRET]) {
    expect(inspect(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  }
}

describe('gramática estricta y acuerdo con parseEnv', () => {
  it.each(['a=b=c', 'a/b+c=', 'a$b', '${B}', 'a\\b', 'tail\\', 'a"bc', "a'bc", 'a`bc', 'é€', '1=2', ''])('acepta literal sin expansión: %s', value => {
    const text = `DATABASE_PASSWORD=${value}`;
    expect(parseStrictEnv(text)).toEqual({ DATABASE_PASSWORD: value });
    expect(parseEnv(text)).toEqual({ DATABASE_PASSWORD: value });
  });
  it('rechaza en la práctica contraseñas con # porque parseEnv las trunca', () => {
    expect(parseEnv('A=ab#c')).toEqual({ A: 'ab' });
    expect(parseEnv('A=#c')).toEqual({ A: '' });
    expectCode(() => parseStrictEnv('DATABASE_PASSWORD=ab#c'), 'H-ENV-PARSE');
    expectCode(() => parseStrictEnv('DATABASE_PASSWORD=#c'), 'H-ENV-PARSE');
  });
  it('compara también valores de claves desconocidas antes de ignorarlas', () => {
    expectCode(() => parseStrictEnv('UNKNOWN=ab#c'), 'H-ENV-PARSE');
    expect(parseStrictEnv('UNKNOWN=a/b+c=')).toEqual({});
  });
  it.each(['DATABASE_HOST=localhost\nDATABASE_HOST=localhost', 'DATABASE_HOST=localhost\nDATABASE_HOST=127.0.0.1'])('rechaza duplicados conocidos idénticos y distintos %#', text => {
    expectCode(() => parseStrictEnv(text), 'H-ENV-DUP');
    expect(() => parseStrictEnv(text)).toThrow(expect.objectContaining({ fields: { key: 'DATABASE_HOST' } }));
  });
  it('un duplicado dentro de un comentario NO es duplicado', () => {
    expect(parseStrictEnv('#DATABASE_HOST=other\nDATABASE_HOST=localhost\n# DATABASE_HOST=again')).toEqual({ DATABASE_HOST: 'localhost' });
  });
  it('ignora duplicados de claves desconocidas', () => {
    expect(parseStrictEnv('UNKNOWN=first\nUNKNOWN=last\nDATABASE_HOST=localhost')).toEqual({ DATABASE_HOST: 'localhost' });
  });
  it('normaliza CRLF y admite comentarios y líneas realmente vacías', () => {
    const text = '# c=1\r\nDATABASE_HOST=localhost\r\n\r\n#A=1\r\n';
    expect(parseStrictEnv(text)).toEqual({ DATABASE_HOST: 'localhost' });
    expect(parseStrictEnv('#A=1')).toEqual({});
    expect(Object.isFrozen(parseStrictEnv(text))).toBe(true);
  });
  it.each([
    ' A=1', ' ', 'A =1', 'A= 1', 'A=1 ', 'A=\t1', 'A', 'a-b=1', '1A=1', '=1',
    'A="abc"', "A='abc'", 'A=`abc`', 'A="first\nDATABASE_HOST=other\nlast"', 'A=first\nlast',
    'export A=1', 'export A=\n export B=2', 'export\tA=1', 'A=x\rB=2', 'A=\0', '#comment\t',
    'A=\x7f', 'A=\u0085', 'A=   \nB=2', '\ufeffA=1', 'A=\u00a0',
  ])('rechaza forma ambigua, multilínea, control o gramática inválida %#', text => {
    expectCode(() => parseStrictEnv(text), 'H-ENV-PARSE');
  });
  it('aplica el límite exacto de 64 líneas', () => {
    expect(parseStrictEnv('\n'.repeat(63))).toEqual({});
    expectCode(() => parseStrictEnv('\n'.repeat(64)), 'H-ENV-SIZE');
  });
  it('corpus diferencial: 6000 ficheros, semilla 0xc7b10001, ninguna aceptación discrepante', () => {
    const corpus = parseCorpus();
    let accepted = 0;
    let parseRejected = 0;
    let duplicateRejected = 0;
    corpus.forEach(({ text, values, code }, index) => {
      if (code) {
        let caught: unknown;
        try { parseStrictEnv(text); } catch (error) { caught = error; }
        expect({ index, code: caught instanceof HarnessError ? caught.code : undefined }).toEqual({ index, code });
        if (code === 'H-ENV-PARSE') parseRejected++; else duplicateRejected++;
      } else {
        const parsed = parseStrictEnv(text);
        const node = parseEnv(text.replace(/\r\n/g, '\n'));
        // values incluye TODAS las claves, incluso desconocidas; procede del generador independiente.
        expect({ index, node }).toEqual({ index, node: values });
        const known = Object.fromEntries(Object.entries(node).filter(([key]) => KNOWN_ENV_KEYS.includes(key)));
        expect(parsed).toEqual(known);
        accepted++;
      }
    });
    expect({ total: corpus.length, accepted, parseRejected, duplicateRejected }).toEqual({
      total: 6000, accepted: 1000, parseRejected: 4500, duplicateRejected: 500,
    });
  });
});

describe('lectura de entorno exclusivamente en temporales sintéticos', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => {
    try { expect(f.descriptors.size).toBe(0); } finally { f.cleanup(); }
    jest.restoreAllMocks();
  });
  it('lee ambos roles, separa secretos y congela profundamente el resultado', () => {
    f.write('app'); f.write('owner');
    const result = readEnvFiles(f.deps);
    expect(result).toEqual({
      app: { host: '127.0.0.1', port: 5433, database: 'synthetic_test', user: 'agenda_test_synthetic_app', poolMax: 5 },
      owner: { host: '127.0.0.1', port: 5433, database: 'synthetic_test', user: 'agenda_test_synthetic_owner', poolMax: 5 },
      secrets: [APP_SECRET, OWNER_SECRET],
    });
    for (const value of [result, result.app, result.owner, result.secrets]) expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify([result.app, result.owner])).not.toContain(APP_SECRET);
    expect(JSON.stringify([result.app, result.owner])).not.toContain(OWNER_SECRET);
    expect(f.closed).toHaveLength(2);
  });
  it.each([0o600, 0o400])('acepta permisos reales %i', mode => {
    f.write('app', envText(), mode);
    expect(readEnvFile('app', f.deps).secrets).toEqual([APP_SECRET]);
  });
  it.each([0o644, 0o640, 0o660, 0o620, 0o700, 0o4600, 0o1600, 0o000, 0o200])('rechaza permisos fstat %i incluso modos sin lectura', mode => {
    f.write('app');
    const original = f.guardedFs.fstatSync;
    jest.spyOn(f.guardedFs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => true, mode }));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-PERM');
    expect(f.closed).toHaveLength(1);
  });
  for (const mode of [0o644, 0o640, 0o660, 0o620, 0o700, 0o4600, 0o1600]) {
    // La capacidad se comprueba antes de registrar el caso, solo en un temporal sintético.
    let removedSpecialBit = false;
    if ((mode & 0o7000) !== 0) {
      const probe = fixture();
      try {
        probe.write('app', envText(), mode);
        const fd = probe.guardedFs.openSync(probe.filename('app'), fs.constants.O_RDONLY);
        let retained: number;
        try { retained = probe.guardedFs.fstatSync(fd).mode & 0o7777; }
        finally { probe.guardedFs.closeSync(fd); }
        removedSpecialBit = retained === (mode & 0o777);
        if (retained !== mode && !removedSpecialBit) throw new Error(`Modo inesperado en comprobación de capacidad: ${retained.toString(8)}`);
      } finally { probe.cleanup(); }
    }
    const test = removedSpecialBit ? it.skip : it;
    const reason = removedSpecialBit ? ' — no aplicable: el sistema de ficheros/sandbox elimina el bit especial al hacer chmod' : '';
    test.each([mode])(`rechaza permisos reales con bit de lectura 0o${mode.toString(8)}${reason}`, requested => {
      f.write('app', envText(), requested);
      const fd = f.guardedFs.openSync(f.filename('app'), fs.constants.O_RDONLY);
      let retained: number;
      try { retained = f.guardedFs.fstatSync(fd).mode & 0o7777; }
      finally { f.guardedFs.closeSync(fd); }
      expect(retained).toBe(requested);
      expectCode(() => readEnvFile('app', f.deps), 'H-ENV-PERM');
    });
  }
  it('abre con O_RDONLY | O_NOFOLLOW | O_NONBLOCK y cierra su descriptor', () => {
    f.write('app');
    const open = jest.spyOn(f.guardedFs, 'openSync');
    readEnvFile('app', f.deps);
    expect(open).toHaveBeenCalledWith(f.filename('app'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    expect(f.closed).toHaveLength(1);
  });
  it('rechaza enlace simbólico sin seguirlo', () => {
    f.write('owner');
    fs.symlinkSync(f.filename('owner'), f.filename('app'));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-LINK');
    expect(f.closed).toHaveLength(0);
  });
  it('rechaza enlace duro por nlink', () => {
    f.write('owner'); fs.linkSync(f.filename('owner'), f.filename('app'));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-LINK');
    expect(f.closed).toHaveLength(1);
  });
  it('rechaza FIFO real sin bloquear; usa fstat inyectado solo si mkfifo no existe', () => {
    if (fs.existsSync('/usr/bin/mkfifo')) {
      execFileSync('/usr/bin/mkfifo', [f.filename('app')], { shell: false, timeout: 10000 });
    } else {
      f.write('app');
      const original = f.guardedFs.fstatSync;
      jest.spyOn(f.guardedFs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => false }));
    }
    const read = jest.spyOn(f.guardedFs, 'readSync');
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-TYPE');
    expect(read).not.toHaveBeenCalled();
    expect(f.closed).toHaveLength(1);
  });
  it('rechaza dispositivo /dev/null simulado por fstat, sin abrir ni leer el dispositivo real', () => {
    f.write('app');
    const original = f.guardedFs.fstatSync;
    jest.spyOn(f.guardedFs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => false, mode: 0o20666 }));
    const read = jest.spyOn(f.guardedFs, 'readSync');
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-TYPE');
    expect(read).not.toHaveBeenCalled();
  });
  it('rechaza un directorio', () => {
    fs.mkdirSync(f.filename('app'));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-TYPE');
  });
  it('rechaza propietario ajeno mediante fstat inyectado', () => {
    f.write('app');
    const original = f.guardedFs.fstatSync;
    jest.spyOn(f.guardedFs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => true, uid: process.getuid!() + 1 }));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-OWNER');
  });
  it.each([8192, 8193])('límite de bytes %i', size => {
    const prefix = envText() + '\n#';
    f.write('app', prefix + 'x'.repeat(size - Buffer.byteLength(prefix)));
    if (size === 8192) expect(readEnvFile('app', f.deps).secrets).toEqual([APP_SECRET]);
    else expectCode(() => readEnvFile('app', f.deps), 'H-ENV-SIZE');
  });
  it('detecta crecimiento después de fstat con lectura acotada a 8193 bytes', () => {
    f.write('app', 'x'.repeat(9000));
    const original = f.guardedFs.fstatSync;
    jest.spyOn(f.guardedFs, 'fstatSync').mockImplementation(fd => ({ ...original(fd), isFile: () => true, size: 10 }));
    const read = jest.spyOn(f.guardedFs, 'readSync');
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-SIZE');
    const total = read.mock.results.reduce((sum, result) => sum + Number(result.value), 0);
    expect(total).toBe(8193);
    expect(f.closed).toHaveLength(1);
  });
  it.each([Buffer.from([0xc3, 0x28]), Buffer.from('\ufeff' + envText()), Buffer.from(envText() + '\0')])('rechaza UTF-8 inválido, BOM y NUL %#', bytes => {
    f.write('app', bytes);
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-ENCODING');
    expect(f.closed).toHaveLength(1);
  });
  it('rechaza más de 64 líneas', () => {
    f.write('app', envText() + '\n'.repeat(64));
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-SIZE');
  });
  it.each(['win32', 'freebsd'])('rechaza plataforma %s antes de abrir', platform => {
    expectCode(() => readEnvFiles({ ...f.deps, platform }), 'H-PLATFORM');
    expect(f.opened).toEqual([]);
  });
  it.each(['darwin', 'linux'])('acepta plataforma compatible %s', platform => {
    f.write('app');
    expect(readEnvFile('app', { ...f.deps, platform }).connection.host).toBe('127.0.0.1');
  });
  it('solo abre los dos nombres fijos bajo un root, nunca señuelos', () => {
    f.write('app'); f.write('owner'); f.decoys();
    readEnvFiles(f.deps);
    expect(f.opened).toEqual([path.join(f.root, ENV_FILES.app), path.join(f.root, ENV_FILES.owner)]);
  });
  it('guardedFs rechaza rutas externas, y no permite root relativo', () => {
    expect(() => f.guardedFs.openSync(path.join(f.root, '..', 'outside-synthetic'), fs.constants.O_RDONLY)).toThrow();
    expectCode(() => readEnvFile('app', { ...f.deps, root: 'relative' }), 'H-ARGS');
    expect(f.opened).toEqual([]);
  });
  it('traduce ausencia y fallos de apertura sin retener el error externo', () => {
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-READ');
    jest.spyOn(f.guardedFs, 'openSync').mockImplementation(() => { throw new Error(THIRD_PARTY_SECRET); });
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-READ');
  });
  it.each(['fstatSync', 'readSync'] as const)('cierra también si falla %s', method => {
    f.write('app');
    jest.spyOn(f.guardedFs, method).mockImplementation(() => { throw new Error(THIRD_PARTY_SECRET); });
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-READ');
    expect(f.closed).toHaveLength(1);
  });
  it('traduce fallo de cierre sin lanzar desde finally ni filtrar secretos', () => {
    f.write('app');
    const close = f.guardedFs.closeSync;
    jest.spyOn(f.guardedFs, 'closeSync').mockImplementation(fd => { close(fd); throw new Error(THIRD_PARTY_SECRET); });
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-READ');
  });
  it.each(['DATABASE_HOST=localhost', 'DATABASE_PORT=5434', 'DATABASE_NAME=other_test'])('rechaza inconsistencia %s', override => {
    f.write('app');
    const owner = envText('owner').split('\n').filter(line => !line.startsWith(override.split('=')[0] + '='));
    f.write('owner', [...owner, override].join('\n'));
    expectCode(() => readEnvFiles(f.deps), 'H-ENV-MISMATCH');
    expect(f.closed).toHaveLength(2);
  });
  it.each([
    ['DATABASE_HOST=localhost\nDATABASE_HOST=localhost', 'H-ENV-DUP'],
    ['DATABASE_HOST=not-loopback', 'H-ENV-VALUE'],
    ['UNKNOWN=ab#c', 'H-ENV-PARSE'],
    ['export UNKNOWN=1', 'H-ENV-PARSE'],
  ])('cierra en rechazo de contenido %#', (extra, code) => {
    f.write('app', envText() + '\n' + extra);
    expectCode(() => readEnvFile('app', f.deps), code);
    expect(f.closed).toHaveLength(1);
  });
  it('detecta duplicados antes de validar configuración y no propaga desconocidas', () => {
    f.write('app', 'DATABASE_HOST=localhost\nDATABASE_HOST=localhost');
    expectCode(() => readEnvFile('app', f.deps), 'H-ENV-DUP');
    f.write('app', envText() + '\nUNKNOWN=first\nUNKNOWN=last');
    expect(Object.keys(readEnvFile('app', f.deps).connection).sort()).toEqual(['database', 'host', 'poolMax', 'port', 'user']);
  });
});
