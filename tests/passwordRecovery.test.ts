import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { CONFIRMATION_MESSAGE, SIMULATION_NOTE, SUCCESS_MESSAGE, normalizeEmail, validateEmail, validatePasswords, requestRecovery } from '../src/features/recovery/recoveryPresentation';
import { RECOVERY_ROUTES, recoveryScreen } from '../src/platform/routes';
import { resolveRoute } from '../src/auth/routeGuard';

for (const route of Object.values(RECOVERY_ROUTES)) {
  for (const session of ['none', 'workspace', 'platform_admin'] as const) {
    for (const slash of ['', '/']) for (const suffix of ['', '?x=1', '#section', '?x=1#section']) {
      test(`recuperación ${session}: ${route + slash + suffix}`, () => {
        assert.deepEqual(resolveRoute(session, route + slash + suffix), session === 'none'
          ? { view: 'recovery' } : session === 'workspace'
            ? { view: 'workspace', redirectTo: '/' } : { view: 'platform', redirectTo: '/plataforma' });
        assert.equal(recoveryScreen(route + slash + suffix), recoveryScreen(route));
      });
    }
    test(`mayúsculas y descendientes desconocidos: ${session} ${route}`, () => {
      for (const path of [route.toUpperCase(), route.replace('/recuperar', '/Recuperar'), route + '/extra', route + '//']) {
        assert.equal(recoveryScreen(path), null);
        assert.deepEqual(resolveRoute(session, path), resolveRoute(session, '/desconocida'));
      }
    });
  }
}

test('correo: formato, vacío, normalización y límite 120', () => {
  assert.equal(validateEmail(''), 'Escribe tu correo.');
  assert.equal(validateEmail('   '), 'Escribe tu correo.');
  for (const value of ['nombre', 'a@b', 'a b@dominio.com', 'a@@dominio.com', 'a@dominio.']) {
    assert.equal(validateEmail(value), 'Escribe un correo válido, por ejemplo nombre@dominio.com.');
  }
  assert.equal(normalizeEmail('  NOMBRE@DOMINIO.COM  '), 'nombre@dominio.com');
  assert.equal(validateEmail('  NOMBRE@DOMINIO.COM  '), '');
  const limit = 'a'.repeat(114) + '@b.com';
  assert.equal(limit.length, 120);
  assert.equal(validateEmail(limit), '');
  assert.notEqual(validateEmail('a' + limit), '');
});

test('respuesta única sin enumeración ni correo en el resultado', () => {
  const existing = requestRecovery('existente@dominio.com');
  const missing = requestRecovery('inexistente@dominio.com');
  assert.deepEqual(existing, missing);
  assert.deepEqual(existing, { error: '', destination: '/recuperar/enviado', message: CONFIRMATION_MESSAGE });
  assert.equal(CONFIRMATION_MESSAGE, 'Si el correo corresponde a una cuenta, recibirás instrucciones para restablecer el acceso.');
  assert.equal(requestRecovery('').destination, undefined);
});

test('contraseñas: vacías, 7/8 caracteres, coincidencia y errores sin valores', () => {
  assert.deepEqual(validatePasswords('', ''), { password: 'Usa al menos 8 caracteres.', repeated: 'Repite la contraseña.' });
  assert.deepEqual(validatePasswords('abcdefg', 'abcdefg'), { password: 'Usa al menos 8 caracteres.', repeated: '' });
  assert.deepEqual(validatePasswords('abcdefgh', 'abcdefgh'), { password: '', repeated: '' });
  assert.deepEqual(validatePasswords('abcdefgh', 'ijklmnop'), { password: '', repeated: 'Las contraseñas deben coincidir.' });
  for (const [first, second] of [['abcdefg', 'xyz'], ['abcdefgh', 'ijklmnop']]) {
    const messages = JSON.stringify(validatePasswords(first, second));
    assert.ok(!messages.includes(first));
    assert.ok(!messages.includes(second));
  }
});

test('funciones puras: almacenamiento instrumentado y datos intactos', () => {
  const workspace = { users: [{ id: 'u1', email: 'existente@dominio.com' }], companies: [{ id: 'c1' }], posts: [{ id: 'p1' }] };
  const platform = { organizations: [{ id: 'o1' }], memberAccess: [{ userId: 'u1', status: 'active' }] };
  const data = new Map([['workspace', JSON.stringify(workspace)], ['platform', JSON.stringify(platform)]]);
  const before = JSON.stringify({ workspace, platform, data: [...data] });
  let reads = 0, writes = 0;
  const storage = { getItem: (key: string) => { reads++; return data.get(key) ?? null; }, setItem: (key: string, value: string) => { writes++; data.set(key, value); } };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    for (const email of ['', 'bad', 'existente@dominio.com', 'inexistente@dominio.com']) {
      normalizeEmail(email); validateEmail(email); requestRecovery(email);
    }
    validatePasswords('', ''); validatePasswords('abcdefgh', 'abcdefgh'); validatePasswords('abcdefg', 'other');
    assert.equal(reads, 0); assert.equal(writes, 0);
    assert.equal(JSON.stringify({ workspace, platform, data: [...data] }), before);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('fronteras recursivas: sin persistencia, red, acciones ni datos privados', () => {
  function inspect(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { inspect(url); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = readFileSync(url, 'utf8');
      assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|history\s*\.|\bstate\s*:|console\s*\.|\bactions\b|\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
      const ast = ts.createSourceFile(entry.name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        assert.ok(!/(^|\/)store(\/|$)/.test(specifier));
        if (/(^|\/)platform(\/|$)/.test(specifier)) assert.equal(specifier, '../../platform/routes');
      }
    }
  }
  inspect(new URL('../src/features/recovery/', import.meta.url));
});

test('inputs no controlados, lecturas solo al enviar y limpieza antes del éxito/al desmontar', () => {
  const source = readFileSync(new URL('../src/features/recovery/RecoveryPage.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('RecoveryPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let passwords = 0;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'input') {
      const attrs = node.attributes.properties;
      if (attrs.some(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'type' && a.initializer?.getText(ast) === '"password"')) {
        passwords++;
        for (const attr of attrs) {
          assert.ok(ts.isJsxAttribute(attr), 'No spreads que puedan controlar el input');
          assert.ok(!['value', 'defaultValue', 'onChange', 'onInput'].includes(attr.name.getText(ast)));
        }
        assert.match(node.getText(ast), /autoComplete="new-password"/);
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useState') {
      assert.ok(["''", "{ password: '', repeated: '' }", 'false'].includes(node.arguments[0].getText(ast)));
    }
    if (ts.isCallExpression(node) && /^set(Error|Errors|Success)/.test(node.expression.getText(ast))) {
      assert.doesNotMatch(node.getText(ast), /\.value/);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(passwords, 2);
  assert.match(source, /validatePasswords\(first.value, second.value\)/);
  assert.match(source, /first.value = '';\s*second.value = '';\s*setSuccess\(true\)/);
  assert.match(source, /return \(\) => \{\s*if \(first\) first.value = '';\s*if \(second\) second.value = '';/);
  assert.match(source, /message.current\?\.focus\(\)/);
  assert.match(source, /main.current\?\.focus/);
  assert.match(source, /email.current\?\.focus/);
  assert.match(source, /navigate\(RECOVERY_ROUTES.sent\)/);
  assert.equal((source.match(/<h1\b/g) ?? []).length, 1);
  assert.match(source, /<p className="notice">\{SIMULATION_NOTE\}<\/p>\s*\{screen === 'request'/);
  assert.equal(SIMULATION_NOTE, 'Simulación: no se envía ningún correo ni se guarda ninguna contraseña. Esta demostración no usa contraseñas.');
  assert.match(SUCCESS_MESSAGE, /No se guardó ninguna contraseña/);
  const login = readFileSync(new URL('../src/features/auth/Login.tsx', import.meta.url), 'utf8');
  assert.match(login, /<Link[^>]*to="\/recuperar"[^>]*>¿Olvidaste tu contraseña\?<\/Link>/);
});

test('App separa recuperación de los efectos de los almacenes y de los shells', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const publicApp = app.split('export function App() {')[1].split('function SessionApp()')[0];
  assert.match(publicApp, /return <RecoveryPage/);
  assert.doesNotMatch(publicApp, /useStore\(|platformStore\.|<Workspace|<PlatformShell/);
  assert.match(app, /function SessionApp\(\)/);
});
