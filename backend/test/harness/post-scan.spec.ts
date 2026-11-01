import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanPaths } from '../../scripts/harness/post-scan.cjs';
import { secretVariants } from '../../scripts/harness/secret-variants.cjs';

const secret = 'SYN-Scan-漢-é-42';
describe('post-scan UN-R8', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-b2-scan-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  it.each([0, 200, 65530, 65536, 131070])('detecta secretos en offset %i y cierra descriptores', offset => {
    const filename = path.join(root, 'artifact');
    fs.writeFileSync(filename, Buffer.concat([Buffer.alloc(offset, 0x78), Buffer.from(secret), Buffer.alloc(200)]));
    const closeSync = jest.fn(fs.closeSync);
    expect(() => scanPaths([filename], [secret], { fs: { ...fs, closeSync } })).toThrow(expect.objectContaining({ code: 'H-SCAN-HIT', fields: { file: 'scan-entry' } }));
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it('detecta todas las variantes en subdirectorios', () => {
    const nested = path.join(root, 'one', 'two'); fs.mkdirSync(nested, { recursive: true });
    const filename = path.join(nested, 'artifact');
    for (const variant of secretVariants(secret)) {
      fs.writeFileSync(filename, variant);
      expect(() => scanPaths([root], [secret])).toThrow(expect.objectContaining({ code: 'H-SCAN-HIT' }));
    }
  });
  it('omite y cuenta enlaces simbólicos y no regulares sin abrirlos', () => {
    const target = path.join(root, 'target'); fs.writeFileSync(target, secret);
    const symbolic = path.join(root, 'symbolic'); fs.symlinkSync(target, symbolic);
    expect(scanPaths([symbolic], [secret])).toEqual({ scanned: 0, skippedLinks: 1, skippedSpecial: 0, hardLinked: 0 });
    for (const kind of ['device', 'fifo', 'socket']) {
      const openSync = jest.fn(fs.openSync);
      const stat = { ...fs.lstatSync(target), isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false };
      const lstatSync = jest.fn(() => stat) as unknown as typeof fs.lstatSync;
      expect(scanPaths([path.join(root, kind)], [secret], { fs: { ...fs, lstatSync, openSync } })).toEqual({ scanned: 0, skippedLinks: 0, skippedSpecial: 1, hardLinked: 0 });
      expect(openSync).not.toHaveBeenCalled();
    }
  });
  it('analiza enlaces duros con nlink 2: secreto detectado por cualquiera de los nombres', () => {
    const first = path.join(root, 'first'); const second = path.join(root, 'second');
    fs.writeFileSync(first, secret); fs.linkSync(first, second);
    expect(fs.lstatSync(first).nlink).toBe(2);
    for (const filename of [first, second]) expect(() => scanPaths([filename], [secret])).toThrow(expect.objectContaining({ code: 'H-SCAN-HIT' }));
    fs.writeFileSync(first, 'clean!');
    expect(scanPaths([first, second], [secret])).toEqual({ scanned: 2, skippedLinks: 0, skippedSpecial: 0, hardLinked: 2 });
  });
  it('impone tamaño, crecimiento durante lectura, profundidad y entradas', () => {
    const filename = path.join(root, 'large'); fs.writeFileSync(filename, Buffer.alloc(17));
    expect(() => scanPaths([filename], [secret], { maxFileBytes: 16 })).toThrow(expect.objectContaining({ code: 'H-RDX-4', fields: { file: 'scan-entry' } }));
    const fstatSync = ((fd: number) => { const stat = fs.fstatSync(fd); stat.size = 0; return stat; }) as typeof fs.fstatSync;
    const closeSync = jest.fn(fs.closeSync);
    expect(() => scanPaths([filename], [secret], { maxFileBytes: 16, fs: { ...fs, fstatSync, closeSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(() => scanPaths([root], [secret], { maxDepth: 0 })).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
    expect(() => scanPaths([root], [secret], { maxEntries: 1 })).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
  });
  it('directorio vacío y archivos limpios devuelven resultados congelados', () => {
    expect(scanPaths([root], [secret])).toEqual({ scanned: 0, skippedLinks: 0, skippedSpecial: 0, hardLinked: 0 });
    fs.writeFileSync(path.join(root, 'clean'), Buffer.alloc(140000, 0x78));
    const result = scanPaths([root], [secret]);
    expect(result).toEqual({ scanned: 1, skippedLinks: 0, skippedSpecial: 0, hardLinked: 0 }); expect(Object.isFrozen(result)).toBe(true);
  });
  it('error seguro aunque el nombre del archivo contenga el secreto', () => {
    const filename = path.join(root, secret); fs.writeFileSync(filename, secret);
    try { scanPaths([filename], [secret]); throw new Error('missing hit'); }
    catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: 'H-SCAN-HIT' }));
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });
  it('abre solo con las tres banderas requeridas y cierra también ante un fallo de lectura', () => {
    const filename = path.join(root, 'clean'); fs.writeFileSync(filename, 'clean');
    const openSync = jest.fn(fs.openSync); const closeSync = jest.fn(fs.closeSync);
    const readSync = jest.fn(() => { throw new Error('synthetic read failure'); });
    expect(() => scanPaths([filename], [secret], { fs: { ...fs, openSync, closeSync, readSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4', fields: { file: 'scan-entry' } }));
    expect(openSync).toHaveBeenCalledWith(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it.each(['EACCES', 'EIO', 'ELOOP', 'ENOENT'])('apertura %s falla cerrado sin intentar cerrar un fd inexistente', code => {
    const filename = path.join(root, 'clean'); fs.writeFileSync(filename, 'clean');
    const openSync = jest.fn(() => { throw Object.assign(new Error(secret), { code }); });
    const closeSync = jest.fn(fs.closeSync);
    expect(() => scanPaths([filename], [secret], { fs: { ...fs, openSync, closeSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4', fields: { file: 'scan-entry' } }));
    expect(closeSync).not.toHaveBeenCalled();
  });
  it.each([-1, NaN, Infinity, 0.5, 65537, 0])('lectura inválida/inconsistente %s falla cerrado y cierra fd', count => {
    const filename = path.join(root, 'clean'); fs.writeFileSync(filename, 'clean');
    const readSync = jest.fn(() => count); const closeSync = jest.fn(fs.closeSync);
    expect(() => scanPaths([filename], [secret], { fs: { ...fs, readSync, closeSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4', fields: { file: 'scan-entry' } }));
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it('rechaza una lectura mayor que lo pedido aunque quepa en el bloque', () => {
    const filename = path.join(root, 'clean'); fs.writeFileSync(filename, 'clean');
    const closeSync = jest.fn(fs.closeSync);
    expect(() => scanPaths([filename], [secret], { maxFileBytes: 5, fs: { ...fs, readSync: () => 7, closeSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4' }));
    expect(closeSync).toHaveBeenCalledTimes(1);
  });
  it.each(['lstat', 'directory', 'fstat', 'read', 'close'])('%s ilegible o fallido no se ignora', operation => {
    const filename = path.join(root, 'clean'); fs.writeFileSync(filename, 'clean');
    const fail = () => { throw new Error(secret); };
    const closeSync = jest.fn((fd: number) => { fs.closeSync(fd); if (operation === 'close') fail(); });
    const overrides = operation === 'lstat' ? { lstatSync: fail } : operation === 'directory' ? { readdirSync: fail } : operation === 'fstat' ? { fstatSync: fail } : operation === 'read' ? { readSync: fail } : {};
    expect(() => scanPaths([operation === 'directory' ? root : filename], [secret], { fs: { ...fs, ...overrides, closeSync } })).toThrow(expect.objectContaining({ code: 'H-RDX-4', fields: { file: 'scan-entry' } }));
    expect(closeSync).toHaveBeenCalledTimes(['lstat', 'directory'].includes(operation) ? 0 : 1);
  });
});
