import 'reflect-metadata';
import { isUuidV7, Uuid7Generator } from './uuid7-generator';

describe('UUID v7', () => {
  it('genera 10000 ids canónicos únicos, ordenados y con timestamp actual', () => {
    const start = Date.now();
    const generator = new Uuid7Generator();
    const ids = Array.from({ length: 10000 }, () => generator.next());
    const end = Date.now();
    expect(new Set(ids).size).toBe(10000);
    expect(ids.every(isUuidV7)).toBe(true);
    expect(ids).toEqual([...ids].sort());
    for (const id of [ids[0], ids[ids.length - 1]]) {
      const timestamp = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
      expect(timestamp).toBeGreaterThanOrEqual(start);
      expect(timestamp).toBeLessThanOrEqual(end);
    }
  });
  it.each(['', '550e8400-e29b-41d4-a716-446655440000', '019ABC00-0000-7000-8000-000000000000', '019abc00-0000-7000-7000-000000000000', '019abc00-0000-7000-8000-000000000000x'])('rechaza %p', value => expect(isUuidV7(value)).toBe(false));
  it('acepta versión 7 y variante RFC', () => expect(isUuidV7('019abc00-0000-7000-b000-000000000000')).toBe(true));
});
