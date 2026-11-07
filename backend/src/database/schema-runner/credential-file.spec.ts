import * as nodeFs from 'node:fs';
import { assertOwnerTarget, defaultCredentialFs, loadOwnerConfiguration, MAX_CREDENTIAL_BYTES, readPrivateCredentialFile, type CredentialFs, type FileFacts } from './credential-file';
import { DatabaseConnectionConfig, DatabaseCredentials } from '../../config/database-credentials';
import { SchemaRunnerError } from './schema-target';

const SECRET = 'fake-owner-password-for-unit-tests-0001';
const ENV_TEXT = ['NODE_ENV=test', 'DATABASE_HOST=127.0.0.1', 'DATABASE_PORT=5433', 'DATABASE_NAME=agenda_test', 'DATABASE_USER=agenda_test_owner', `DATABASE_PASSWORD=${SECRET}`].join('\n') + '\n';

interface Fake { fs: CredentialFs; calls: string[]; reads: number }
function fake(over: { file?: Partial<FileFacts> & { text?: string }; dir?: Partial<FileFacts>; platform?: string; uid?: number | undefined; openFails?: boolean; readFails?: boolean; fstatFails?: boolean; dirFails?: boolean } = {}): Fake {
  const text = over.file?.text ?? ENV_TEXT;
  const bytes = Buffer.from(text, 'utf8');
  const calls: string[] = []; const state = { reads: 0 };
  const facts = (o: Partial<FileFacts>, kind: 'file' | 'dir'): FileFacts => ({
    isFile: () => kind === 'file', isDirectory: () => kind === 'dir', nlink: 1, uid: 501, mode: kind === 'file' ? 0o100600 : 0o040755, size: bytes.length, ...o,
  });
  const fs: CredentialFs = {
    platform: over.platform ?? 'darwin', uid: 'uid' in over ? over.uid : 501, flags: 0x1234,
    open: (path, flags) => { calls.push(`open:${flags}`); if (over.openFails) throw new Error(`ELOOP ${path} ${SECRET}`); return 7; },
    fstat: () => { calls.push('fstat'); if (over.fstatFails) throw new Error('x'); return facts(over.file ?? {}, 'file'); },
    stat: () => { calls.push('stat'); if (over.dirFails) throw new Error('x'); return facts(over.dir ?? {}, 'dir'); },
    read: (_fd, buffer, offset, length, position) => {
      calls.push('read'); state.reads++;
      if (over.readFails) throw new Error('x');
      const n = Math.min(length, Math.max(0, bytes.length - position)); buffer.set(bytes.subarray(position, position + n), offset); return n;
    },
    close: () => { calls.push('close'); },
  };
  return { fs, calls, get reads() { return state.reads; } };
}
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof SchemaRunnerError ? e.code : 'other'; } return null; };

describe('lectura privada del archivo de credenciales', () => {
  it('lee con un solo descriptor, comprobando antes de leer y cerrando al final', () => {
    const f = fake();
    expect(readPrivateCredentialFile('/x/.env.test.migration', f.fs)).toBe(ENV_TEXT);
    expect(f.calls).toEqual(['stat', 'open:4660', 'fstat', 'read', 'read', 'close']);
  });
  it('acepta modo 0400 y rechaza cualquier otro', () => {
    expect(readPrivateCredentialFile('/x/f', fake({ file: { mode: 0o100400 } }).fs)).toBe(ENV_TEXT);
    for (const mode of [0o100644, 0o100640, 0o100604, 0o100660, 0o100666, 0o100700, 0o100000, 0o100200])
      expect([mode, codeOf(() => readPrivateCredentialFile('/x/f', fake({ file: { mode } }).fs))]).toEqual([mode, 'credential_file_unsafe']);
  });
  it.each([
    ['no es archivo regular', { file: { isFile: () => false } }], ['enlace duro', { file: { nlink: 2 } }], ['dueño distinto', { file: { uid: 0 } }],
    ['vacío', { file: { size: 0, text: '' } }], ['demasiado grande', { file: { size: MAX_CREDENTIAL_BYTES + 1 } }],
  ])('rechaza: %s, sin leer contenido', (_name, over) => {
    const f = fake(over as never);
    expect(codeOf(() => readPrivateCredentialFile('/x/f', f.fs))).toBe('credential_file_unsafe');
    expect(f.reads).toBe(0);
    expect(f.calls[f.calls.length - 1]).toBe('close');
  });
  it('rechaza el contenido que cambió de tamaño o no es UTF-8', () => {
    expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ file: { size: ENV_TEXT.length - 3 } }).fs))).toBe('credential_file_unsafe');
    expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ file: { size: ENV_TEXT.length + 3 } }).fs))).toBe('credential_file_unsafe');
    const f = fake();
    const bad: CredentialFs = { ...f.fs, fstat: () => ({ ...f.fs.fstat(1), size: 2 }), read: (_fd, buffer, offset, _length, position) => { if (position >= 2) return 0; buffer.set([0xff, 0xfe], offset); return 2; } };
    expect(codeOf(() => readPrivateCredentialFile('/x/f', bad))).toBe('credential_file_unsafe');
  });
  it('rechaza directorios ajenos o escribibles por otros, antes de abrir', () => {
    for (const dir of [{ uid: 0 }, { mode: 0o040775 }, { mode: 0o040757 }, { mode: 0o040777 }, { isDirectory: () => false }]) {
      const f = fake({ dir });
      expect(codeOf(() => readPrivateCredentialFile('/x/f', f.fs))).toBe('credential_dir_unsafe');
      expect(f.calls).toEqual(['stat']);
    }
    expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ dirFails: true }).fs))).toBe('credential_dir_unsafe');
  });
  it('un enlace simbólico o un fallo de apertura/lectura se traduce a un código, sin filtrar nada', () => {
    let caught: unknown;
    try { readPrivateCredentialFile('/x/f', fake({ openFails: true }).fs); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaRunnerError);
    expect((caught as SchemaRunnerError).code).toBe('credential_file_unreadable');
    expect(JSON.stringify(caught) + String(caught) + ((caught as Error).stack ?? '')).not.toContain(SECRET);
    expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ readFails: true }).fs))).toBe('credential_file_unreadable');
    const f = fake({ fstatFails: true });
    expect(codeOf(() => readPrivateCredentialFile('/x/f', f.fs))).toBe('credential_file_unreadable');
    expect(f.calls[f.calls.length - 1]).toBe('close');
  });
  it('solo darwin y linux, y solo con uid conocido', () => {
    for (const platform of ['win32', 'freebsd']) expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ platform }).fs))).toBe('credential_platform');
    expect(codeOf(() => readPrivateCredentialFile('/x/f', fake({ uid: undefined }).fs))).toBe('credential_platform');
    expect(readPrivateCredentialFile('/x/f', fake({ platform: 'linux' }).fs)).toBe(ENV_TEXT);
  });
});

describe('puerto real del sistema de archivos', () => {
  it('abre solo para lectura, sin seguir enlaces simbólicos y sin bloquear', () => {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = nodeFs.constants;
    expect(defaultCredentialFs.flags).toBe(O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    expect(O_NOFOLLOW).toBeGreaterThan(0);
    expect(defaultCredentialFs.flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)).toBe(0);
    expect(defaultCredentialFs.flags & O_NOFOLLOW).toBe(O_NOFOLLOW);
    expect(Object.isFrozen(defaultCredentialFs)).toBe(true);
  });
});

describe('configuración del dueño de las migraciones', () => {
  it('pasa por el cargador existente con el contenido ya leído y no abre el archivo dos veces', () => {
    const f = fake();
    const config = loadOwnerConfiguration({ cwd: '/work', fs: f.fs });
    expect(config.describe()).toBe('agenda_test_owner@127.0.0.1:5433/agenda_test');
    expect(f.calls.filter(c => c.startsWith('open')).length).toBe(1);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(String(config)).not.toContain(SECRET);
  });
  it('una comprobación de privacidad fallida impide leer el contenido', () => {
    const f = fake({ file: { mode: 0o100644 } });
    expect(codeOf(() => loadOwnerConfiguration({ cwd: '/work', fs: f.fs }))).toBe('credential_file_unsafe');
    expect(f.reads).toBe(0);
  });
  it.each([
    ['contraseña ausente', ENV_TEXT.replace(/DATABASE_PASSWORD=.*\n/, '')], ['rol de aplicación', ENV_TEXT.replace('agenda_test_owner', 'agenda_test_app')],
    ['base de desarrollo', ENV_TEXT.replace('agenda_test', 'agenda_dev')], ['host remoto', ENV_TEXT.replace('127.0.0.1', 'db.example.com')],
    ['puerto distinto', ENV_TEXT.replace('5433', '5432')],
  ])('rechaza con código y sin filtrar la contraseña: %s', (_name, text) => {
    let caught: unknown;
    try { loadOwnerConfiguration({ cwd: '/work', fs: fake({ file: { text } }).fs }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaRunnerError);
    expect(['credential_invalid', 'target_mismatch']).toContain((caught as SchemaRunnerError).code);
    expect(String(caught) + ((caught as Error).stack ?? '')).not.toContain(SECRET);
  });
  it('el objetivo exige loopback, puerto, base y usuario exactos', () => {
    const make = (host: string, port: number, name: string, user: string) => new DatabaseConnectionConfig(host, port, name, new DatabaseCredentials(user, SECRET), 1);
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(() => assertOwnerTarget(make(host, 5433, 'agenda_test', 'agenda_test_owner'))).not.toThrow();
    for (const bad of [make('10.0.0.5', 5433, 'agenda_test', 'agenda_test_owner'), make('127.0.0.1', 5432, 'agenda_test', 'agenda_test_owner'),
      make('127.0.0.1', 5433, 'agenda_other_test', 'agenda_test_owner'), make('127.0.0.1', 5433, 'agenda_test', 'agenda_test_app')])
      expect(codeOf(() => assertOwnerTarget(bad))).toBe('target_mismatch');
  });
});
