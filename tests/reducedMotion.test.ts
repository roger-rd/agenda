import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { preferredScrollBehavior } from '../src/lib/scroll';

function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(url) : [url];
  });
}
test('scroll consulta matchMedia en cada llamada: reduce y no-preference', () => {
  for (const matches of [true, false, true]) {
    const media = ((query: string) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return { matches };
    }) as typeof window.matchMedia;
    assert.equal(preferredScrollBehavior(media), matches ? 'auto' : 'smooth');
  }
});
test('CSS: reset global acotado a la aplicación cubre todas las declaraciones de movimiento', () => {
  const cssFiles = files(new URL('../src/', import.meta.url)).filter(url => url.pathname.endsWith('.css'));
  for (const file of cssFiles) {
    const css = readFileSync(file, 'utf8');
    if (!/(?:transition|animation)\s*:|scroll-behavior\s*:\s*smooth/.test(css)) continue;
    const reset = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*html, body, #root, #root \*, #root \*::before, #root \*::after\s*\{([^}]+)\}\s*\}/.exec(css);
    assert.ok(reset, file.pathname);
    for (const property of ['transition: none', 'animation: none', 'scroll-behavior: auto']) {
      assert.ok(reset[1].includes(`${property} !important`), property);
    }
    // Ninguna declaración posterior puede anular el reset de accesibilidad.
    assert.doesNotMatch(css.slice(reset.index + reset[0].length), /(?:transition|animation|scroll-behavior)\s*:/);
  }
});
test('JS: smooth solo vive en la utilidad que consulta la preferencia', () => {
  for (const file of files(new URL('../src/', import.meta.url)).filter(url => /\.tsx?$/.test(url.pathname))) {
    if (file.pathname.endsWith('/lib/scroll.ts')) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), /['"]smooth['"]/, file.pathname);
  }
});
