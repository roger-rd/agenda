import { createHash } from 'node:crypto';
import type { MigrationInterface } from 'typeorm';
import { InitialSchema1794009600000 } from './1794009600000-initial-schema';
import { COUNTS, DOWN_STATEMENTS, UP_STATEMENTS } from './initial-schema.statements';

export interface ManifestEntry {
  readonly name: string;
  readonly timestamp: number;
  readonly migration: new () => MigrationInterface;
  readonly up: readonly string[];
  readonly down: readonly string[];
  /** SHA-256 of JSON.stringify([up, down]), pinned here independently of the statements file. */
  readonly sha256: string;
  readonly counts: Readonly<typeof COUNTS>;
  /** `down` destroys data: it is limited to development and test databases. */
  readonly downScope: 'development-and-test-only';
  readonly immutable: true;
}

/** Digest used by the pin. Changing a single character of a published migration changes it. */
export const digestOf = (up: readonly string[], down: readonly string[]): string => createHash('sha256').update(JSON.stringify([up, down])).digest('hex');

/**
 * Explicit list of the migrations, in application order. No globbing and no discovery: a migration exists only if it is
 * listed here with its pinned digest. A published entry must never be edited; add a new one instead.
 */
export const SCHEMA_MANIFEST: readonly ManifestEntry[] = Object.freeze([
  Object.freeze({
    name: 'InitialSchema1794009600000',
    timestamp: 1794009600000,
    migration: InitialSchema1794009600000,
    up: UP_STATEMENTS,
    down: DOWN_STATEMENTS,
    sha256: '33d0baa69ac1943dd6908af3382456fcecf3048ccd0ba282a466a32aa958f0ab',
    counts: COUNTS,
    downScope: 'development-and-test-only',
    immutable: true,
  } as const),
]);

/** Problems found in a manifest; empty means consistent. Pure, so the future runner can call it before touching a database. */
export function verifyManifest(entries: readonly ManifestEntry[] = SCHEMA_MANIFEST): readonly string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  let previous = 0;
  for (const entry of entries) {
    const prefix = entry.name;
    if (names.has(entry.name)) problems.push(`${prefix}: duplicate name`);
    names.add(entry.name);
    if (!new RegExp(`^[A-Za-z]+${entry.timestamp}$`).test(entry.name)) problems.push(`${prefix}: name does not end with its timestamp`);
    if (!Number.isSafeInteger(entry.timestamp) || entry.timestamp <= previous) problems.push(`${prefix}: timestamps must strictly increase`);
    previous = entry.timestamp;
    if (new entry.migration().constructor.name !== entry.name) problems.push(`${prefix}: class name differs`);
    if (digestOf(entry.up, entry.down) !== entry.sha256) problems.push(`${prefix}: statements differ from the pinned digest`);
    if (entry.downScope !== 'development-and-test-only' || entry.immutable !== true) problems.push(`${prefix}: scope or immutability flag changed`);
  }
  return problems;
}
