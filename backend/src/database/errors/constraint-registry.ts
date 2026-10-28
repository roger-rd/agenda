import { Injectable } from '@nestjs/common';
import { own } from '../../logging/error-sanitizer';
interface MessageEntry { code: string; field?: string; message: string }
export interface UniqueEntry extends MessageEntry { kind: 'unique'; name: string }
export interface CheckEntry extends MessageEntry { kind: 'check'; name: string; origin: 'input' | 'internal' }
export interface NotNullEntry extends MessageEntry { kind: 'not_null'; table: string; column: string; origin: 'input' | 'internal' }
export interface ForeignKeyEntry { kind: 'foreign_key'; name: string; childTable: string; parentTable: string; referenceIn?: 'body' | 'path'; field?: string; writeMessage?: string; restrictCode?: string; tenantBoundary?: boolean }
export type ConstraintEntry = UniqueEntry | CheckEntry | NotNullEntry | ForeignKeyEntry;
const identifier = /^[a-z][a-z0-9_]{0,62}$(?![\s\S])/;
const codePattern = /^[a-z][a-z0-9_]{1,40}$(?![\s\S])/;
function matches(value: unknown, pattern: RegExp): boolean { return typeof value === 'string' && pattern.test(value); }
function message(value: unknown): boolean { return typeof value === 'string' && value.length <= 200 && !/[\r\n\u2028\u2029]/.test(value); }
@Injectable()
export class ConstraintRegistry {
  private readonly entries = new Map<string, Readonly<ConstraintEntry>>();
  get size(): number { return this.entries.size; }
  register(input: ConstraintEntry): void {
    const entry: Record<string, unknown> = {};
    for (const key of ['kind', 'name', 'table', 'column', 'origin', 'code', 'field', 'message', 'childTable', 'parentTable', 'referenceIn', 'writeMessage', 'restrictCode', 'tenantBoundary']) {
      const value = own(input, key); if (value !== undefined) entry[key] = value;
    }
    const fail = () => { throw new Error('Registro de restricción inválido.'); };
    if (!['unique', 'check', 'not_null', 'foreign_key'].includes(entry.kind as string)) fail();
    if (entry.field !== undefined && !matches(entry.field, /^[A-Za-z][A-Za-z0-9_]{0,40}$(?![\s\S])/)) fail();
    if (entry.kind === 'not_null') {
      if (!matches(entry.table, identifier) || !matches(entry.column, identifier)) fail();
    } else {
      if (!matches(entry.name, /^(pk|fk|uq|ck|ix)_[a-z0-9_]{1,59}$(?![\s\S])/)) fail();
      const prefixes = entry.kind === 'unique' ? ['uq_', 'pk_'] : entry.kind === 'check' ? ['ck_'] : ['fk_'];
      if (!prefixes.some(prefix => (entry.name as string).startsWith(prefix))) fail();
    }
    if (entry.kind === 'foreign_key') {
      if (!matches(entry.childTable, identifier) || !matches(entry.parentTable, identifier) ||
        (entry.referenceIn !== undefined && !['body', 'path'].includes(entry.referenceIn as string)) ||
        (entry.tenantBoundary !== undefined && typeof entry.tenantBoundary !== 'boolean') ||
        (entry.restrictCode !== undefined && !matches(entry.restrictCode, codePattern)) ||
        (entry.writeMessage !== undefined && !message(entry.writeMessage))) fail();
      entry.referenceIn ??= 'body';
    } else {
      if (!matches(entry.code, codePattern) || !message(entry.message)) fail();
      if (entry.kind !== 'unique' && !['input', 'internal'].includes(entry.origin as string)) fail();
    }
    const key = entry.kind === 'not_null' ? `not_null:${entry.table as string}:${entry.column as string}` : entry.name as string;
    if (this.entries.has(key) || this.size >= 500) fail();
    this.entries.set(key, Object.freeze(entry) as unknown as Readonly<ConstraintEntry>);
  }
  unique(name?: string): Readonly<UniqueEntry> | undefined { const e = this.entries.get(name ?? ''); return e?.kind === 'unique' ? e : undefined; }
  check(name?: string): Readonly<CheckEntry> | undefined { const e = this.entries.get(name ?? ''); return e?.kind === 'check' ? e : undefined; }
  foreignKey(name?: string): Readonly<ForeignKeyEntry> | undefined { const e = this.entries.get(name ?? ''); return e?.kind === 'foreign_key' ? e : undefined; }
  notNull(table?: string, column?: string): Readonly<NotNullEntry> | undefined { const e = this.entries.get(`not_null:${table}:${column}`); return e?.kind === 'not_null' ? e : undefined; }
}
