import { Injectable } from '@nestjs/common';
import { v7 } from 'uuid';
import { IdGenerator } from './id-generator';

@Injectable()
export class Uuid7Generator extends IdGenerator {
  next(): string { return v7(); }
}

// Solo representación canónica en minúsculas.
export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
