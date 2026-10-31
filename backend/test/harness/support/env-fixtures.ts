import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV_FILES } from '../../../scripts/harness/constants.cjs';
import type { ReadFs, Role } from '../../../scripts/harness/env-files.cjs';
import { APP_SECRET, OWNER_SECRET } from './synthetic-secrets';

export function input(role: Role = 'app'): Record<string, unknown> {
  return { DATABASE_NAME: 'synthetic_test', DATABASE_USER: `agenda_test_synthetic_${role}`,
    DATABASE_PASSWORD: role === 'app' ? APP_SECRET : OWNER_SECRET };
}

export function envText(role: Role = 'app'): string {
  return Object.entries(input(role)).map(([key, value]) => `${key}=${String(value)}`).join('\n');
}

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-b1-'));
  const opened: string[] = [];
  const closed: number[] = [];
  const descriptors = new Set<number>();
  const check = (filename: string) => {
    const relative = path.relative(root, path.resolve(filename));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Acceso fuera del temporal sintético.');
    }
  };
  const descriptor = (fd: number) => {
    if (!descriptors.has(fd)) throw new Error('Descriptor fuera del temporal sintético.');
  };
  const guardedFs: ReadFs = {
    constants: fs.constants,
    openSync(filename, flags) {
      check(filename);
      // También impide seguir enlaces fuera del temporal si una regresión quitara NOFOLLOW.
      if (fs.lstatSync(filename, { throwIfNoEntry: false })?.isSymbolicLink()) {
        check(path.resolve(path.dirname(filename), fs.readlinkSync(filename)));
      }
      opened.push(filename);
      const fd = fs.openSync(filename, flags);
      descriptors.add(fd);
      return fd;
    },
    fstatSync(fd) { descriptor(fd); return fs.fstatSync(fd); },
    readSync(fd, buffer, offset, length, position) {
      descriptor(fd); return fs.readSync(fd, buffer, offset, length, position);
    },
    closeSync(fd) {
      descriptor(fd); fs.closeSync(fd); descriptors.delete(fd); closed.push(fd);
    },
  };
  return {
    root, guardedFs, opened, closed, descriptors,
    deps: { root, fs: guardedFs, platform: 'linux', getuid: () => process.getuid!() },
    filename: (role: Role) => path.join(root, ENV_FILES[role]),
    write(role: Role, text: string | Buffer = envText(role), mode = 0o600) {
      const filename = path.join(root, ENV_FILES[role]);
      fs.writeFileSync(filename, text, { mode });
      fs.chmodSync(filename, mode);
    },
    decoys() {
      fs.mkdirSync(path.join(root, 'infra'));
      for (const name of ['.env', '.env.migration', 'infra/.env']) {
        fs.writeFileSync(path.join(root, name), 'DECOY=synthetic', { mode: 0o600 });
      }
    },
    cleanup() {
      for (const fd of descriptors) fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** LCG reproducible, aritmética uint32. */
export function generator(seed: number) {
  let state = seed >>> 0;
  return (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
}

export interface CorpusCase {
  text: string;
  values: Record<string, string>;
  code?: 'H-ENV-PARSE' | 'H-ENV-DUP';
}

/** 6000 documentos: 24 familias, semilla fija, valores esperados construidos sin parser. */
export function parseCorpus(): CorpusCase[] {
  const next = generator(0xc7b10001);
  const symbols = ['plain', 'a=b=c', 'a/b+c=', 'a$b', '${B}', 'a\\b', 'a"bc', "a'bc", 'a`bc', 'é€', '1=2', '', 'tail\\'];
  return Array.from({ length: 6000 }, (_, index) => {
    const values: Record<string, string> = {
      DATABASE_NAME: 'synthetic_test', DATABASE_USER: 'agenda_test_synthetic_app', DATABASE_PASSWORD: APP_SECRET,
      DATABASE_HOST: 'localhost', DATABASE_PORT: '5433', DATABASE_POOL_MAX: '5',
    };
    for (let i = 0; i < 1 + next(6); i++) values[`UNKNOWN_${i}`] = symbols[next(symbols.length)];
    const lines = ['# DATABASE_HOST=comment', '', ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
    let code: CorpusCase['code'];
    switch (index % 24) {
      case 0: break;
      case 1: lines.push('A="abc"'); code = 'H-ENV-PARSE'; break;
      case 2: lines.push("A='abc'"); code = 'H-ENV-PARSE'; break;
      case 3: lines.push('A=`abc`'); code = 'H-ENV-PARSE'; break;
      case 4: lines.push('export A=1'); code = 'H-ENV-PARSE'; break;
      case 5: lines.push(' A=1'); code = 'H-ENV-PARSE'; break;
      case 6: lines.push('A =1'); code = 'H-ENV-PARSE'; break;
      case 7: lines.push('A= 1'); code = 'H-ENV-PARSE'; break;
      case 8: lines.push('A=\t1'); code = 'H-ENV-PARSE'; break;
      case 9: lines.push('A="first\nDATABASE_HOST=other\nlast"'); code = 'H-ENV-PARSE'; break;
      case 10: lines.push('A=x\rB=2'); code = 'H-ENV-PARSE'; break;
      case 11: lines.push('A=ab#c'); code = 'H-ENV-PARSE'; break;
      case 12: lines.push('A=#c'); code = 'H-ENV-PARSE'; break;
      case 13: lines.push('a-b=1'); code = 'H-ENV-PARSE'; break;
      case 14: lines.push('1A=1'); code = 'H-ENV-PARSE'; break;
      case 15: lines.push('=1'); code = 'H-ENV-PARSE'; break;
      case 16: lines.push('DATABASE_HOST=localhost'); code = 'H-ENV-DUP'; break;
      case 17: lines.push('DATABASE_HOST=127.0.0.1'); code = 'H-ENV-DUP'; break;
      case 18: lines.push('#DATABASE_HOST=other', ''); break;
      case 19: lines.push('UNKNOWN_DUP=first', 'UNKNOWN_DUP=last'); values.UNKNOWN_DUP = 'last'; break;
      case 20: lines.push('A=   ', 'B=2'); code = 'H-ENV-PARSE'; break;
      case 21: lines.push('export\tA=1'); code = 'H-ENV-PARSE'; break;
      case 22: lines.push('   '); code = 'H-ENV-PARSE'; break;
      case 23: lines.push('# c=1', '#A=1', ''); break;
    }
    const text = lines.join('\n');
    return { text: index % 2 === 0 ? text.replace(/\n/g, '\r\n') : text, values, code };
  });
}
