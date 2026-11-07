import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guarantees of F1.2b-1: the modules are pure or protected configuration. There is no runner, no CLI, no session
 * and no driver here, so nothing can open a connection, write a file or run migrations.
 */
const dir = __dirname;
const all = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts')).sort();
/** F1.2b-1 modules: pure or protected configuration. The F1.2b-2 modules (runner, session, CLI) have their own static spec. */
const sources = all.filter(f => !['schema-runner.ts', 'typeorm-session.ts', 'cli.ts'].includes(f));
const text = (file: string) => readFileSync(join(dir, file), 'utf8');
const code = (file: string) => text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const REVEAL = new RegExp(`\\.${'reveal'}${'Password'}\\(`);

describe('módulos del runner de esquema (F1.2b-1)', () => {
  it('son exactamente cinco; los únicos módulos adicionales son el ejecutor, la sesión TypeORM y la línea de órdenes de F1.2b-2', () => {
    expect(sources).toEqual(['credential-file.ts', 'schema-data-source.ts', 'schema-guards.ts', 'schema-sql.ts', 'schema-target.ts']);
    expect(all).toEqual(['cli.ts', 'credential-file.ts', 'schema-data-source.ts', 'schema-guards.ts', 'schema-runner.ts', 'schema-sql.ts', 'schema-target.ts', 'typeorm-session.ts']);
  });

  it('no abren conexiones, procesos, red ni escriben archivos', () => {
    const forbidden: [string, RegExp][] = [
      ['console', /\bconsole\./], ['process.env', /process\.env/], ['process.exit', /process\.exit/], ['child_process', /child_process/],
      ['red', /node:(?:net|http|https|dns|tls|dgram)\b/], ['eval', /\beval\s*\(|new Function\s*\(/], ['importación dinámica', /\bimport\s*\(/],
      ['require', /\brequire\s*\(/], ['pg', /(?:from|require\()\s*['"]pg['"]/], ['driver pg de typeorm', /typeorm\/driver\/postgres\/(?!PostgresDataSourceOptions)/],
      ['escritura de archivos', /\b(?:writeFile|appendFile|createWriteStream|unlink|rmSync|rmdir|rename|mkdir|copyFile|truncate|chmod|chown|symlink|link)(?:Sync)?\s*\(/],
      ['ejecución de migraciones', /runMigrations|undoLastMigration|showMigrations|MigrationExecutor|executePendingMigrations|\.initialize\s*\(/],
      ['sincronización', /synchronize:\s*true|dropDatabase|\.synchronize\s*\(/], ['temporizadores', /\bsetTimeout|\bsetInterval/],
      ['lectura del entorno', /dotenv|['"`]\.env/],
    ];
    for (const file of sources) for (const [name, pattern] of forbidden) expect([file, name, pattern.test(code(file))]).toEqual([file, name, false]);
  });

  it('typeorm solo se importa como tipo', () => {
    for (const file of sources) for (const line of code(file).split('\n').filter(l => /from\s+'typeorm/.test(l))) expect([file, line.trim().startsWith('import type')]).toEqual([file, true]);
  });

  it('no importan arneses, scripts ni la capa de persistencia', () => {
    for (const file of sources) {
      expect([file, /from\s+'[^']*(?:scripts|test\/harness|harness)/.test(code(file))]).toEqual([file, false]);
      expect([file, /from\s+'[^']*persistence/.test(code(file))]).toEqual([file, false]);
    }
  });

  it('la contraseña se revela una sola vez en todo el directorio, y en el DataSource', () => {
    const hits = sources.flatMap(file => (code(file).match(new RegExp(REVEAL.source, 'g')) ?? []).map(() => file));
    expect(hits).toEqual(['schema-data-source.ts']);
    for (const file of sources.filter(f => f !== 'schema-data-source.ts')) expect(text(file)).not.toMatch(new RegExp(`${'reveal'}${'Password'}`));
  });

  it('el SQL solo está en schema-sql.ts: las demás fuentes no contienen sentencias', () => {
    for (const file of sources.filter(f => f !== 'schema-sql.ts')) {
      expect([file, /['"`]\s*(?:SELECT|REVOKE|GRANT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)\s+\S/.test(code(file))]).toEqual([file, false]);
    }
  });

  it('las constantes de sentencias están congeladas y no se construyen con entrada', () => {
    const sql = code('schema-sql.ts');
    expect(sql).not.toMatch(/\$\{(?!TABLE_ORDER|TARGET\.|MIGRATIONS_TABLE|MIGRATIONS_SEQUENCE|t\b)/);
    expect(sql).toMatch(/Object\.freeze\(\{\s*REVOKE/);
  });
});
