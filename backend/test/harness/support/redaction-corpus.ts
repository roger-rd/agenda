import { escape } from 'node:querystring';
import { inspect } from 'node:util';

export function random(seed: number) {
  let value = seed >>> 0;
  return (limit: number) => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) % limit;
  };
}

export function secretsCorpus(count: number) {
  const next = random(0xc7b20001);
  const alphabet = Array.from('abZ09" \\ \'éñ漢😀#=/+$&@');
  return Array.from({ length: count }, () => Array.from({ length: 16 + next(12) }, () => alphabet[next(alphabet.length)]).join(''));
}

/** Codificadores de plataforma, independientes de secretVariants. */
export function encodings(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  return [secret, json, JSON.stringify(json).slice(1, -1), inspect(secret).slice(1, -1),
    escape(secret), encodeURI(secret), encodeURIComponent(secret),
    new URLSearchParams({ value: secret }).toString().slice(6)];
}

/** Índices de sextetos cuyos seis bits pertenecen íntegramente al secreto. */
export function base64Core(encoded: string, prefixBytes: number, secretBytes: number) {
  return Array.from(encoded).filter((_, j) => 6 * j >= 8 * prefixBytes && 6 * j + 6 <= 8 * (prefixBytes + secretBytes)).join('');
}
