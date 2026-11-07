import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QueryRunner } from 'typeorm';
import { InitialSchema1794009600000 } from './1794009600000-initial-schema';
import { DOWN_STATEMENTS, UP_STATEMENTS } from './initial-schema.statements';
import { SCHEMA_MANIFEST, digestOf, verifyManifest, type ManifestEntry } from './schema-manifest';

const fakeRunner = (database: unknown, options: { failAt?: number } = {}) => {
  const calls: string[] = []; let running = 0; let overlapped = false;
  const runner = { dataSource: { options: { database } }, query: async (sql: string) => {
    if (++running > 1) overlapped = true;
    await Promise.resolve();
    running--;
    calls.push(sql);
    if (options.failAt !== undefined && calls.length === options.failAt) throw new Error('fallo simulado');
    return [];
  } } as unknown as QueryRunner;
  return { runner, calls, overlapped: () => overlapped };
};

describe('manifiesto explícito', () => {
  it('contiene exactamente la migración inicial, congelada, con su clase, huella y alcance de bajada', () => {
    expect(Object.isFrozen(SCHEMA_MANIFEST)).toBe(true);
    expect(SCHEMA_MANIFEST).toHaveLength(1);
    const [entry] = SCHEMA_MANIFEST;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry).toMatchObject({ name: 'InitialSchema1794009600000', timestamp: 1794009600000, migration: InitialSchema1794009600000,
      sha256: '33d0baa69ac1943dd6908af3382456fcecf3048ccd0ba282a466a32aa958f0ab', downScope: 'development-and-test-only', immutable: true,
      counts: { tables: 8, indexes: 9, foreignKeys: 14, uniques: 9, checks: 33, primaryKeys: 8 } });
    expect(entry.up).toBe(UP_STATEMENTS);
    expect(entry.down).toBe(DOWN_STATEMENTS);
  });
  it('la huella fijada coincide con las sentencias, y cualquier cambio la rompe', () => {
    expect(digestOf(UP_STATEMENTS, DOWN_STATEMENTS)).toBe(SCHEMA_MANIFEST[0].sha256);
    expect(digestOf([...UP_STATEMENTS.slice(0, -1), `${UP_STATEMENTS.at(-1)} `], DOWN_STATEMENTS)).not.toBe(SCHEMA_MANIFEST[0].sha256);
    expect(digestOf(UP_STATEMENTS, [...DOWN_STATEMENTS].reverse())).not.toBe(SCHEMA_MANIFEST[0].sha256);
    expect(digestOf([...UP_STATEMENTS].reverse(), DOWN_STATEMENTS)).not.toBe(SCHEMA_MANIFEST[0].sha256);
    expect(digestOf(UP_STATEMENTS.map(s => s.replace('NOT NULL', 'NULL')), DOWN_STATEMENTS)).not.toBe(SCHEMA_MANIFEST[0].sha256);
  });
  it('verifyManifest acepta el manifiesto real y detecta cada manipulación', () => {
    expect(verifyManifest()).toEqual([]);
    const base = SCHEMA_MANIFEST[0];
    const tampered = (patch: Partial<ManifestEntry>) => verifyManifest([{ ...base, ...patch } as ManifestEntry]);
    expect(tampered({ sha256: '0'.repeat(64) })).toEqual(['InitialSchema1794009600000: statements differ from the pinned digest']);
    expect(tampered({ up: [...UP_STATEMENTS, 'DROP TABLE "public"."users"'] })).toEqual(['InitialSchema1794009600000: statements differ from the pinned digest']);
    expect(tampered({ down: [] })).toEqual(['InitialSchema1794009600000: statements differ from the pinned digest']);
    expect(tampered({ name: 'InitialSchema1' })).toEqual(expect.arrayContaining(['InitialSchema1: name does not end with its timestamp', 'InitialSchema1: class name differs']));
    expect(tampered({ timestamp: 0 })).toEqual(expect.arrayContaining(['InitialSchema1794009600000: timestamps must strictly increase']));
    expect(tampered({ downScope: 'anywhere' as never })).toEqual(['InitialSchema1794009600000: scope or immutability flag changed']);
    expect(tampered({ immutable: false as never })).toEqual(['InitialSchema1794009600000: scope or immutability flag changed']);
    expect(verifyManifest([base, base])).toEqual(expect.arrayContaining(['InitialSchema1794009600000: duplicate name', 'InitialSchema1794009600000: timestamps must strictly increase']));
  });
});

describe('clase de migración', () => {
  it('declara su nombre, no fija `transaction` y es compatible con el modo de transacción única', () => {
    const migration = new InitialSchema1794009600000();
    expect(migration.name).toBe('InitialSchema1794009600000');
    expect('transaction' in migration).toBe(false);
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
  it('up ejecuta exactamente las 31 sentencias congeladas, en orden y de una en una, y nada más', async () => {
    const { runner, calls, overlapped } = fakeRunner('agenda_test');
    await new InitialSchema1794009600000().up(runner);
    expect(calls).toEqual([...UP_STATEMENTS]);
    expect(calls).toHaveLength(31);
    expect(overlapped()).toBe(false);
  });
  it('up no consulta la base de datos para decidir nada: funciona igual con cualquier nombre de base', async () => {
    for (const database of ['agenda_test', 'agenda_dev', 'otra', undefined]) {
      const { runner, calls } = fakeRunner(database);
      await new InitialSchema1794009600000().up(runner);
      expect(calls).toHaveLength(31);
    }
  });
  it('si una sentencia falla, propaga el error y no ejecuta las siguientes', async () => {
    const { runner, calls } = fakeRunner('agenda_test', { failAt: 12 });
    await expect(new InitialSchema1794009600000().up(runner)).rejects.toThrow('fallo simulado');
    expect(calls).toEqual(UP_STATEMENTS.slice(0, 12));
  });
  it.each(['agenda_test', 'agenda_dev', 'x_test', 'a1_dev'])('down se permite en la base de desarrollo o pruebas %s y ejecuta las 8 eliminaciones inversas', async database => {
    const { runner, calls } = fakeRunner(database);
    await new InitialSchema1794009600000().down(runner);
    expect(calls).toEqual([...DOWN_STATEMENTS]);
  });
  it.each(['agenda', 'agenda_prod', 'agenda_production', 'agenda_test_backup', 'agenda_dev2', 'AGENDA_TEST', '_test', 'test', '', 'agenda test', 'agenda_test;drop', undefined, null, 5])(
    'down se rechaza para la base %p sin ejecutar ninguna sentencia', async database => {
      const { runner, calls } = fakeRunner(database);
      await expect(new InitialSchema1794009600000().down(runner)).rejects.toThrow('migration_down_forbidden');
      expect(calls).toEqual([]);
    });
  it('si una eliminación falla, down se detiene', async () => {
    const { runner, calls } = fakeRunner('agenda_test', { failAt: 3 });
    await expect(new InitialSchema1794009600000().down(runner)).rejects.toThrow('fallo simulado');
    expect(calls).toEqual(DOWN_STATEMENTS.slice(0, 3));
  });
});

describe('alcance de esta etapa', () => {
  const dir = __dirname;
  const sources = ['1794009600000-initial-schema.ts', 'initial-schema.statements.ts', 'schema-manifest.ts'].map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const);
  it('no se genera DDL en ejecución, no se usa synchronize ni el generador, y no hay E/S, consola ni entorno', () => {
    for (const [file, source] of sources) {
      for (const forbidden of [/synchronize/, /migration:generate/, /createTable\(/, /Table\.create/, /createSchemaBuilder/, /getMetadataArgsStorage/, /process\.env/, /\bconsole\b/,
        /readFileSync|writeFileSync|node:fs/, /child_process|node:net|node:http/, /\.env\b/, /from\s+'[^']*persistence/, /DataSource/]) {
        expect([file, String(forbidden), forbidden.test(source)]).toEqual([file, String(forbidden), false]);
      }
    }
  });
  it('los únicos imports son tipos de typeorm, node:crypto y archivos de la propia carpeta', () => {
    for (const [file, source] of sources) {
      for (const m of source.matchAll(/^import (type )?[^;]*? from '([^']+)'/gm)) {
        const allowed = m[2] === 'node:crypto' || m[2].startsWith('./') || (m[2] === 'typeorm' && m[1] === 'type ');
        expect([file, m[2], allowed]).toEqual([file, m[2], true]);
      }
    }
  });
  it('no existe ningún ejecutor, CLI ni DataSource de migraciones todavía', () => {
    const present = fs.readdirSync(dir).filter(f => !f.endsWith('.spec.ts')).sort();
    expect(present).toEqual(['1794009600000-initial-schema.ts', 'initial-schema.statements.ts', 'schema-manifest.ts']);
  });
});
