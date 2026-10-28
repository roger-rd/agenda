import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';

const privileges = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'crea_en_public', 'crea_en_base'] as const;
export function evaluateDatabaseIdentity(row: unknown, expected: { user: string; database: string }): boolean {
  if (!row || typeof row !== 'object') return false;
  const identity = row as Record<string, unknown>;
  return identity.usuario === expected.user && identity.base === expected.database &&
    privileges.every(key => identity[key] === false);
}

@Injectable()
export class DatabaseIdentityService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource, private readonly config: AppConfigService, private readonly logger: PinoLogger) {}
  async onApplicationBootstrap(): Promise<void> {
    const expected = { user: this.config.database.credentials.user, database: this.config.database.name };
    let rows: unknown;
    try {
      rows = await this.dataSource.query("select current_user as usuario, current_database() as base, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, has_schema_privilege(current_user, 'public', 'CREATE') as crea_en_public, has_database_privilege(current_user, current_database(), 'CREATE') as crea_en_base from pg_roles r where r.rolname = current_user");
    } catch { throw new Error('No se pudo comprobar la identidad de la base de datos.'); }
    if (!Array.isArray(rows) || rows.length !== 1 || !evaluateDatabaseIdentity(rows[0], expected)) {
      throw new Error('La identidad o los privilegios de la base de datos no son seguros.');
    }
    this.logger.info({ event: 'database_identity_verified', ...expected }, 'Identidad de base de datos verificada.');
  }
}
