import { ServiceUnavailableError } from '../common/errors/domain-error';
import { LimitedPasswordHasher, PASSWORD_HASH_CONCURRENCY } from './limited-password-hasher';
import { PasswordHasher } from './password-hasher';

class ControlledHasher extends PasswordHasher {
  active = 0;
  maximum = 0;
  readonly calls: { kind: string; password: unknown; phc?: unknown; resolve: () => void; reject: (error: unknown) => void }[] = [];
  readonly needsRehash = jest.fn((phc: unknown) => phc === 'rehash');

  hash(password: unknown): Promise<string> { return this.start('hash', password, `hash:${String(password)}`); }
  verify(phc: unknown, password: unknown): Promise<boolean> { return this.start('verify', password, password !== 'false', phc); }

  private start<T>(kind: string, password: unknown, result: T, phc?: unknown): Promise<T> {
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    return new Promise<T>((resolve, reject) => {
      this.calls.push({ kind, password, phc,
        resolve: () => { this.active--; resolve(result); },
        reject: error => { this.active--; reject(error); },
      });
    });
  }
}

function mixed(hasher: PasswordHasher, count: number): Promise<string | boolean>[] {
  return Array.from({ length: count }, (_, i) => i % 2 === 0 ? hasher.hash(i) : hasher.verify(`phc:${i}`, i));
}

async function drain(inner: ControlledHasher, promises: Promise<string | boolean>[], offset = 0) {
  for (let i = 0; i < promises.length; i++) {
    inner.calls[offset + i].resolve();
    await expect(promises[i]).resolves.toBe(i % 2 === 0 ? `hash:${i}` : true);
  }
}

describe('LimitedPasswordHasher', () => {
  it('comparte cuatro cupos y avanza en FIFO entre hash y verify', async () => {
    const inner = new ControlledHasher();
    const hasher = new LimitedPasswordHasher(inner);
    const pending = mixed(hasher, 12);
    expect(inner.calls.map(call => call.password)).toEqual([0, 1, 2, 3]);
    // Liberar fuera del orden de entrada no altera el orden de la cola.
    inner.calls[2].resolve();
    await pending[2];
    expect(inner.calls.map(call => call.password)).toEqual([0, 1, 2, 3, 4]);
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      inner.calls[i].resolve();
      await pending[i];
    }
    expect(inner.calls.map(call => call.password)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(inner.calls[1]).toMatchObject({ kind: 'verify', phc: 'phc:1', password: 1 });
    expect(inner.maximum).toBe(4);
    expect(inner.active).toBe(0);
  });

  it('rechaza la solicitud 37 sin invocar al interno y completa las 36 aceptadas', async () => {
    expect(PASSWORD_HASH_CONCURRENCY).toEqual({ active: 4, queued: 32 });
    const inner = new ControlledHasher();
    const hasher = new LimitedPasswordHasher(inner);
    const pending = mixed(hasher, 36);
    const overflow = hasher.hash('overflow');
    await expect(overflow).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(overflow).rejects.toMatchObject({ code: 'service_unavailable', httpStatus: 503, retryAfterSeconds: 1 });
    expect(inner.calls).toHaveLength(4);
    await drain(inner, pending);
    expect(inner.calls).toHaveLength(36);
    expect(inner.maximum).toBe(4);
    expect(inner.active).toBe(0);
  });

  it.each(['hash', 'verify'] as const)('libera tras fallo de %s y recupera los 36 cupos', async kind => {
    const inner = new ControlledHasher();
    const hasher = new LimitedPasswordHasher(inner);
    const failed = kind === 'hash' ? hasher.hash('fail') : hasher.verify('phc', 'fail');
    const error = new Error('fallo interno');
    const rejection = expect(failed).rejects.toBe(error);
    const pending = mixed(hasher, 4);
    expect(inner.calls).toHaveLength(4);
    inner.calls[0].reject(error);
    await rejection;
    expect(inner.calls).toHaveLength(5);
    await drain(inner, pending, 1);
    const recovered = mixed(hasher, 36);
    await expect(hasher.verify('phc', 'overflow')).rejects.toBeInstanceOf(ServiceUnavailableError);
    await drain(inner, recovered, 5);
    expect(inner.maximum).toBe(4);
    expect(inner.active).toBe(0);
  });

  it('delega needsRehash sin cupos y conserva ambos resultados de verify', async () => {
    const inner = new ControlledHasher();
    const hasher = new LimitedPasswordHasher(inner, 1, 0);
    for (const password of ['true', 'false']) {
      const result = hasher.verify('phc', password);
      expect(hasher.needsRehash('rehash')).toBe(true);
      expect(inner.needsRehash).toHaveBeenCalledWith('rehash');
      await expect(hasher.hash('overflow')).rejects.toBeInstanceOf(ServiceUnavailableError);
      inner.calls[inner.calls.length - 1].resolve();
      await expect(result).resolves.toBe(password === 'true');
    }
  });

  it('respeta límites personalizados y reserva el relevo frente a nuevas llamadas', async () => {
    const inner = new ControlledHasher();
    const hasher = new LimitedPasswordHasher(inner, 1, 1);
    const first = hasher.hash('first');
    const second = hasher.verify('phc', 'second');
    inner.calls[0].resolve();
    const third = first.then(() => hasher.hash('third'));
    await first;
    expect(inner.calls.map(call => call.password)).toEqual(['first', 'second']);
    inner.calls[1].resolve();
    await second;
    expect(inner.calls.map(call => call.password)).toEqual(['first', 'second', 'third']);
    inner.calls[2].resolve();
    await third;
    expect(inner.maximum).toBe(1);
  });

  it('libera también si el interno lanza un error síncrono', async () => {
    const inner = new ControlledHasher();
    const error = new Error('síncrono');
    jest.spyOn(inner, 'hash').mockImplementationOnce(() => { throw error; });
    const hasher = new LimitedPasswordHasher(inner, 1, 0);
    await expect(hasher.hash('fail')).rejects.toBe(error);
    const next = hasher.hash('next');
    inner.calls[0].resolve();
    await expect(next).resolves.toBe('hash:next');
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('rechaza activeLimit inválido %s', value => {
    expect(() => new LimitedPasswordHasher(new ControlledHasher(), value)).toThrow(RangeError);
  });
  it.each([-1, 0.5, NaN, Infinity, -Infinity])('rechaza queueLimit inválido %s', value => {
    expect(() => new LimitedPasswordHasher(new ControlledHasher(), 1, value)).toThrow(RangeError);
  });
});
