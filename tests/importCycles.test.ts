import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

test('todo src mantiene un grafo de importaciones relativas sin ciclos', () => {
  const files = new Set(sourceFiles(root));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const edges = new Set<string>();
    graph.set(file, edges);
    // El parser ya instalado evita falsos positivos en comentarios y cadenas.
    // Incluye imports de tipos, reexportaciones e imports dinámicos literales.
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const add = (specifier: ts.Node | undefined) => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return;
      const path = resolve(dirname(file), specifier.text);
      if (extname(path) && !/\.(?:tsx?|jsx?)$/.test(path)) return;
      const base = path.replace(/\.jsx?$/, '');
      const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
        .find(candidate => files.has(candidate));
      assert.ok(target, `Importación sin resolver: ${relative(root, file)} -> ${specifier.text}`);
      edges.add(target);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0]);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const visited = new Set<string>(), active = new Set<string>(), path: string[] = [];
  const cycles: string[] = [];
  const visit = (file: string) => {
    if (active.has(file)) {
      cycles.push([...path.slice(path.indexOf(file)), file].map(p => `src/${relative(root, p)}`).join(' -> '));
      return;
    }
    if (visited.has(file)) return;
    visited.add(file); active.add(file); path.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    path.pop(); active.delete(file);
  };
  for (const file of files) visit(file);
  assert.equal(cycles.length, 0, `Ciclos de importación:\n${cycles.join('\n')}`);
});
