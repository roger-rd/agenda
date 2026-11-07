import * as nodeFs from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseConnectionConfig } from '../../config/database-credentials';
import { loadMigrationEnvironment, migrationEnvFile } from '../../config/migration-environment';
import { LOOPBACK_HOSTS, SchemaRunnerError, TARGET } from './schema-target';

/** What the checks need to know about a file or directory. */
export interface FileFacts {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly nlink: number;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
}

/** Narrow filesystem port, injectable so the checks are tested without touching a disk. Read-only by construction. */
export interface CredentialFs {
  readonly platform: string;
  readonly uid: number | undefined;
  readonly flags: number;
  open(path: string, flags: number): number;
  fstat(fd: number): FileFacts;
  stat(path: string): FileFacts;
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export const MAX_CREDENTIAL_BYTES = 4096;

export const defaultCredentialFs: CredentialFs = Object.freeze({
  platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  flags: nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK,
  open: (path: string, flags: number) => nodeFs.openSync(path, flags),
  fstat: (fd: number) => nodeFs.fstatSync(fd),
  stat: (path: string) => nodeFs.statSync(path),
  read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => nodeFs.readSync(fd, buffer, offset, length, position),
  close: (fd: number) => nodeFs.closeSync(fd),
});

/**
 * Reads the credential file through ONE descriptor, so what is checked is what is read (no check/use gap):
 * regular file, opened without following a final symlink, single link, owned by the current user, mode 0600 or 0400,
 * bounded size, in a directory that nobody else can write to. Nothing is read when a check fails, and no error carries
 * a path, a value or any content: only a code.
 */
export function readPrivateCredentialFile(path: string, fs: CredentialFs = defaultCredentialFs): string {
  if (fs.platform !== 'darwin' && fs.platform !== 'linux') throw new SchemaRunnerError('credential_platform');
  if (typeof fs.uid !== 'number') throw new SchemaRunnerError('credential_platform');
  let directory: FileFacts;
  try { directory = fs.stat(dirname(path)); } catch { throw new SchemaRunnerError('credential_dir_unsafe'); }
  if (!directory.isDirectory() || directory.uid !== fs.uid || (directory.mode & 0o022) !== 0) throw new SchemaRunnerError('credential_dir_unsafe');

  let fd: number;
  try { fd = fs.open(path, fs.flags); } catch { throw new SchemaRunnerError('credential_file_unreadable'); }
  try {
    let facts: FileFacts;
    try { facts = fs.fstat(fd); } catch { throw new SchemaRunnerError('credential_file_unreadable'); }
    const mode = facts.mode & 0o777;
    if (!facts.isFile() || facts.nlink !== 1 || facts.uid !== fs.uid || (mode !== 0o600 && mode !== 0o400) ||
      !Number.isSafeInteger(facts.size) || facts.size <= 0 || facts.size > MAX_CREDENTIAL_BYTES) throw new SchemaRunnerError('credential_file_unsafe');
    const buffer = new Uint8Array(facts.size + 1);
    let total = 0;
    try {
      for (;;) {
        const n = fs.read(fd, buffer, total, buffer.length - total, total);
        if (n <= 0) break;
        total += n;
        if (total >= buffer.length) break;
      }
    } catch { throw new SchemaRunnerError('credential_file_unreadable'); }
    if (total !== facts.size) throw new SchemaRunnerError('credential_file_unsafe');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)); }
    catch { throw new SchemaRunnerError('credential_file_unsafe'); }
  } finally {
    try { fs.close(fd); } catch { /* the descriptor is gone with the process; nothing to report */ }
  }
}

/** The configuration is the owner's, for exactly the fixed target. Any other value is refused with a code. */
export function assertOwnerTarget(config: DatabaseConnectionConfig): void {
  const ok = LOOPBACK_HOSTS.includes(config.host) && config.port === TARGET.port && config.name === TARGET.database &&
    config.credentials.user === TARGET.owner;
  if (!ok) throw new SchemaRunnerError('target_mismatch');
}

/**
 * Credentials of the migration owner for the test target: private-file check first, then the existing loader and its
 * validation over the already-read contents (the file is never opened a second time).
 */
export function loadOwnerConfiguration({ cwd, fs = defaultCredentialFs }: { cwd: string; fs?: CredentialFs }): DatabaseConnectionConfig {
  const file = migrationEnvFile('test');
  if (!file) throw new SchemaRunnerError('credential_invalid');
  const path = resolve(cwd, file);
  const contents = readPrivateCredentialFile(path, fs);
  let config: DatabaseConnectionConfig;
  try {
    config = loadMigrationEnvironment({ nodeEnv: 'test', cwd, env: {}, readFile: requested => { if (requested !== path) throw new Error('unexpected path'); return contents; } });
  } catch { throw new SchemaRunnerError('credential_invalid'); }
  assertOwnerTarget(config);
  return config;
}
