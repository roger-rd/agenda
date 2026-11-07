import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guarantees of F1.2b-2. The orchestration (schema-runner.ts) knows nothing about the process, files, pg or
 * TypeORM; the TypeORM session (typeorm-session.ts) is the only module that imports TypeORM at run time and may never
 * call the DataSource entry points that bypass the contract; the CLI (cli.ts) is the only one that touches the process.
 */
const dir = __dirname;
const text = (file: string) => readFileSync(join(dir, file), 'utf8');
const code = (file: string) => text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NEW = ['schema-runner.ts', 'typeorm-session.ts', 'cli.ts'];
const hits = (re: RegExp) => NEW.filter(f => re.test(code(f)));

describe('módulos del ejecutor de esquema (F1.2b-2)', () => {
  it('ningún módulo usa consola, entorno, procesos hijo, red, eval ni escribe archivos', () => {
    const forbidden: [string, RegExp][] = [
      ['console', /\bconsole\./], ['process.env', /process\.env/], ['child_process', /child_process/], ['red', /node:(?:net|http|https|dns|tls|dgram)\b/],
      ['eval', /\beval\s*\(|new Function\s*\(/], ['importación dinámica', /\bimport\s*\(/], ['require', /\brequire\s*\((?!\s*\))/],
      ['pg', /(?:from|require\()\s*['"]pg['"]/], ['dotenv', /dotenv|['"`]\.env/],
      ['escritura de archivos', /\b(?:writeFile|appendFile|createWriteStream|unlink|rmSync|rmdir|rename|mkdir|copyFile|truncate|chmod|chown|symlink|link)(?:Sync)?\s*\(/],
      ['contraseña', new RegExp(`${'reveal'}${'Password'}`)], ['persistencia', /from\s+'[^']*persistence/], ['arneses', /from\s+'[^']*(?:scripts|test\/harness|harness)/],
    ];
    for (const [name, re] of forbidden) expect([name, hits(re)]).toEqual([name, []]);
  });

  it('solo cli.ts toca el proceso, los temporizadores y las señales reales', () => {
    expect(hits(/\bprocess\./)).toEqual(['cli.ts']);
    expect(hits(/\bsetTimeout|\bsetInterval|\bperformance\./)).toEqual(['cli.ts']);
    expect(code('cli.ts').match(/\bprocess\.\w+/g)?.sort()).toEqual(['process.argv', 'process.cwd', 'process.exit', 'process.exit', 'process.stdout']);
  });

  it('solo typeorm-session.ts importa TypeORM en tiempo de ejecución; el resto, solo tipos', () => {
    for (const f of NEW) {
      const lines = code(f).split('\n').filter(l => /from\s+'typeorm/.test(l));
      if (f === 'typeorm-session.ts') expect(lines.filter(l => !l.trim().startsWith('import type'))).toEqual([`import { DataSource, MigrationExecutor, type QueryRunner } from 'typeorm';`]);
      else for (const l of lines) expect([f, l.trim().startsWith('import type')]).toEqual([f, true]);
    }
  });

  it('nadie llama a runMigrations, showMigrations, synchronize ni dropDatabase; solo se nombran para bloquearlos', () => {
    const call = /\.(?:runMigrations|showMigrations|synchronize|dropDatabase|executeMigration|getPendingMigrations|getExecutedMigrations)\s*\(/;
    expect(hits(call)).toEqual([]);
    const names = code('typeorm-session.ts').match(/FORBIDDEN_ENTRY_POINTS = \[([^\]]*)\]/)?.[1] ?? '';
    for (const n of ['runMigrations', 'showMigrations', 'undoLastMigration', 'synchronize', 'dropDatabase']) expect(names).toContain(`'${n}'`);
  });

  it('el ejecutor solo se usa con executePendingMigrations y undoLastMigration, y solo con el QueryRunner propio', () => {
    const session = code('typeorm-session.ts');
    expect(session.match(/executor\.(\w+)\(/g)?.sort()).toEqual(['executor.executePendingMigrations(', 'executor.undoLastMigration(']);
    expect(session.match(/new MigrationExecutor\(([^)]*)\)/g)).toEqual(['new MigrationExecutor(ds, qr)']);
    expect(session.match(/createQueryRunner\(/g)?.length).toBeGreaterThanOrEqual(1);
    expect(hits(/\.initialize\s*\(/)).toEqual(['typeorm-session.ts']);
  });

  it('la sesión solo envía texto fijado: nada de sentencias literales fuera de schema-sql.ts', () => {
    for (const f of NEW) expect([f, /['"`]\s*(?:SELECT|REVOKE|GRANT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|BEGIN|COMMIT|ROLLBACK|START)\s+\S/.test(code(f))]).toEqual([f, false]);
    expect(code('typeorm-session.ts')).toMatch(/READABLE\.has\(sql\)/);
    expect(code('typeorm-session.ts')).toMatch(/WRITABLE\.has\(sql\)/);
  });

  it('el ejecutor orquesta sin importar la sesión ni el DataSource, y el resumen se construye campo a campo', () => {
    expect(code('schema-runner.ts')).not.toMatch(/from\s+'\.\/(?:typeorm-session|cli|credential-file|schema-data-source)'/);
    const summary = /export function summaryOf[\s\S]*$/.exec(code('schema-runner.ts'))?.[0] ?? '';
    expect(summary).not.toMatch(/\.\.\.result|Object\.assign|JSON\.stringify/);
  });
});
