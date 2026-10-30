import { AsyncLocalStorage } from 'node:async_hooks';
import { TimerRegistry, type TimerRegistryOptions, type TimerHandle } from './timer-helper';

function hostile(kind: string, error: unknown): PromiseLike<void> {
  const value = kind === 'getter' ? Object.defineProperty({}, 'then', { get: () => { throw error; } }) : {
    then: (fulfilled: (() => void) | undefined, rejected: (reason: unknown) => void): unknown => {
      if (kind === 'lanza') throw error;
      if (kind === 'nunca') return undefined;
      if (kind === 'extraño') return { dato: 1 };
      if (kind === 'promesa devuelta') return Promise.reject(error);
      rejected(error);
      rejected(error);
      fulfilled?.();
      if (kind === 'ambos') {
        // Invocar incluso un manejador ausente no debe escapar del helper.
        (fulfilled as () => void)();
      }
      throw error;
    },
  };
  return value as PromiseLike<void>;
}
function seeded(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

describe('Registro y ámbitos de temporizadores', () => {
  let registries: TimerRegistry[];
  let realTimers: boolean;
  function registry(options?: TimerRegistryOptions): TimerRegistry {
    const result = new TimerRegistry(options);
    registries.push(result);
    return result;
  }
  beforeEach(() => { registries = []; realTimers = false; jest.useFakeTimers(); });
  afterEach(() => {
    try {
      for (const item of registries) expect(item.stats().active).toBe(0);
      if (!realTimers) expect(jest.getTimerCount()).toBe(0);
    } finally { jest.restoreAllMocks(); jest.useRealTimers(); }
  });
  it('dispara una vez y mantiene instantáneas congeladas de solo contadores', () => {
    const item = registry();
    const scope = item.createScope();
    const fn = jest.fn();
    const handle = scope.setTimer(0, fn);
    const snapshot = scope.stats();
    expect(handle.active).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(item.stats())).toBe(true);
    expect(snapshot).toEqual({ active: 1, created: 1, fired: 0, cleared: 0, callbackErrors: 0, handlerErrors: 0, rejectedAfterDispose: 0 });
    jest.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(handle.active).toBe(false);
    handle.clear();
    scope.dispose();
    expect(snapshot.active).toBe(1);
    expect(scope.stats()).toEqual({ ...snapshot, active: 0, fired: 1 });
    expect(item.stats()).toEqual(scope.stats());
  });
  it('cancela pendientes y tolera clear y dispose repetidos', () => {
    const item = registry();
    const scope = item.createScope();
    const fn = jest.fn();
    const handle = scope.setTimer(100, fn);
    scope.setTimer(200, fn);
    handle.clear();
    handle.clear();
    scope.dispose();
    const stats = scope.stats();
    scope.dispose();
    handle.clear();
    jest.runAllTimers();
    expect(fn).not.toHaveBeenCalled();
    expect(scope.disposed).toBe(true);
    expect(scope.stats()).toEqual(stats);
    expect(stats).toMatchObject({ active: 0, created: 2, cleared: 2, fired: 0 });
  });
  it('cierra dentro del callback e impide trabajo vencido en el mismo turno', () => {
    const scope = registry().createScope();
    const fn = jest.fn();
    scope.setTimer(1, () => scope.dispose());
    scope.setTimer(1, fn);
    jest.advanceTimersByTime(1);
    expect(fn).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ created: 2, fired: 1, cleared: 1 });
  });
  it('el wrapper protege también callbacks ya encolados que clearTimeout no retira', () => {
    const scheduled: Array<() => void> = [];
    const original = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      scheduled.push(callback);
      return original(callback, ms);
    }) as typeof setTimeout);
    const scope = registry().createScope();
    const fn = jest.fn();
    const cleared = scope.setTimer(0, fn);
    cleared.clear();
    scope.setTimer(0, () => scope.dispose());
    scope.setTimer(0, fn);
    jest.advanceTimersByTime(0);
    for (const callback of scheduled) callback();
    expect(fn).not.toHaveBeenCalled();
    expect(scope.stats()).toMatchObject({ created: 3, fired: 1, cleared: 2 });
  });
  it('permite crear otro temporizador desde el callback y no retiene los disparados', () => {
    const scope = registry().createScope();
    const fn = jest.fn();
    scope.setTimer(0, () => { scope.setTimer(1, fn); });
    jest.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
    scope.dispose();
    expect(scope.stats()).toMatchObject({ active: 0, created: 2, fired: 2, cleared: 0 });
  });
  it('rechaza creaciones tras cerrar sin validar el plazo', () => {
    const scope = registry().createScope();
    scope.dispose();
    const fn = jest.fn();
    for (const ms of [NaN, -1, Infinity, 0.5, 0]) {
      const handle = scope.setTimer(ms, fn);
      expect(handle).toMatchObject({ id: -1, active: false });
      expect(() => handle.clear()).not.toThrow();
    }
    expect(scope.stats()).toMatchObject({ rejectedAfterDispose: 5, created: 0 });
    expect(fn).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2147483648])('rechaza el plazo %p', ms => {
    const scope = registry().createScope();
    expect(() => scope.setTimer(ms, () => {})).toThrow(new TypeError('Plazo de temporizador inválido.'));
    expect(scope.stats().created).toBe(0);
  });
  it.each([0, 2147483647])('acepta el extremo %i', ms => {
    const scope = registry().createScope();
    const handle = scope.setTimer(ms, () => {});
    expect(handle.active).toBe(true);
    handle.clear();
  });
  it('limpia miles de temporizadores sin contar dos veces', () => {
    const scope = registry().createScope();
    const handles = Array.from({ length: 5000 }, () => scope.setTimer(1000, () => {}));
    for (const handle of handles.slice(0, 1000)) { handle.clear(); handle.clear(); }
    scope.dispose();
    scope.dispose();
    expect(scope.stats()).toMatchObject({ active: 0, created: 5000, fired: 0, cleared: 5000 });
  });
  it('captura excepciones síncronas y entrega el error crudo sin inspeccionarlo', () => {
    const error = new Proxy({}, { get: () => { throw new Error('No inspeccionar.'); } });
    let received: unknown;
    const hook = jest.fn(event => { received = event.error; });
    const scope = registry({ onCallbackError: hook }).createScope();
    const handle = scope.setTimer(0, () => { throw error; });
    expect(() => jest.advanceTimersByTime(0)).not.toThrow();
    expect(received === error).toBe(true);
    expect(hook.mock.calls[0][0].scopeId).toBe(scope.id);
    expect(hook.mock.calls[0][0].timerId).toBe(handle.id);
    expect(scope.stats()).toMatchObject({ fired: 1, callbackErrors: 1, handlerErrors: 0 });
  });
  it.each(['getter', 'lanza', 'repetido', 'ambos', 'nunca', 'extraño', 'promesa devuelta'])('protege el callback thenable: %s', async kind => {
    const error = new Error('Fallo de callback.');
    const hook = jest.fn();
    const scope = registry({ onCallbackError: hook }).createScope();
    scope.setTimer(0, () => hostile(kind, error));
    expect(() => jest.advanceTimersByTime(0)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    const count = ['nunca', 'extraño'].includes(kind) ? 0 : 1;
    expect(scope.stats()).toMatchObject({ callbackErrors: count, handlerErrors: 0, fired: 1 });
    expect(hook).toHaveBeenCalledTimes(count);
  });
  it.each(['getter', 'lanza', 'repetido', 'ambos', 'nunca', 'extraño', 'promesa devuelta'])('protege el hook thenable: %s', async kind => {
    const scope = registry({ onCallbackError: () => hostile(kind, new Error('Fallo de hook.')) }).createScope();
    scope.setTimer(0, () => { throw new Error('Fallo de callback.'); });
    expect(() => jest.advanceTimersByTime(0)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.stats()).toMatchObject({ callbackErrors: 1, handlerErrors: ['nunca', 'extraño'].includes(kind) ? 0 : 1 });
  });
  it('protege la excepción síncrona del hook', () => {
    const scope = registry({ onCallbackError: () => { throw new Error('Fallo de hook.'); } }).createScope();
    scope.setTimer(0, () => { throw new Error('Fallo de callback.'); });
    expect(() => jest.advanceTimersByTime(0)).not.toThrow();
    expect(scope.stats()).toMatchObject({ callbackErrors: 1, handlerErrors: 1 });
  });
  it.each(['callback', 'hook'])('adjunta then(undefined, manejador) al rechazo nativo de %s sin relanzar', async target => {
    const failure = new Error('Rechazo asíncrono.');
    const promise = Promise.reject<void>(failure);
    const then = jest.spyOn(promise, 'then');
    const item = registry(target === 'hook' ? { onCallbackError: () => promise } : {});
    const scope = item.createScope();
    scope.setTimer(0, () => {
      if (target === 'hook') throw failure;
      return promise;
    });
    expect(() => jest.advanceTimersByTime(0)).not.toThrow();
    expect(then).toHaveBeenCalledWith(undefined, expect.any(Function));
    await Promise.resolve();
    await Promise.resolve();
    const reject = then.mock.calls[0][1];
    expect(() => reject?.(failure)).not.toThrow();
    expect(scope.stats()).toMatchObject({ callbackErrors: 1, handlerErrors: target === 'hook' ? 1 : 0 });
  });
  it.each([null, 1, {}, 'error'])('rechaza un hook que no sea función: %p', onCallbackError => {
    expect(() => new TimerRegistry({ onCallbackError } as unknown as TimerRegistryOptions)).toThrow(TypeError);
  });
  it('mantiene los errores asíncronos tras dispose sin detener el trabajo ya iniciado', async () => {
    let reject: (error: unknown) => void = () => {};
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const item = registry();
    const scope = item.createScope();
    scope.setTimer(0, () => pending);
    jest.advanceTimersByTime(0);
    scope.dispose();
    reject(new Error('Fallo tardío.'));
    await Promise.resolve();
    expect(item.stats()).toMatchObject({ active: 0, fired: 1, cleared: 0, callbackErrors: 1 });
  });
  it('solo llama unref cuando se solicita', () => {
    const original = global.setTimeout;
    const unrefs: jest.SpyInstance[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      const timer = original(callback, ms);
      unrefs.push(jest.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setTimeout);
    const scope = registry().createScope();
    scope.setTimer(0, () => {});
    scope.setTimer(0, () => {}, { unref: false });
    scope.setTimer(0, () => {}, { unref: true });
    expect(unrefs.map(spy => spy.mock.calls.length)).toEqual([0, 0, 1]);
    scope.dispose();
  });
  it('B: ejecuta setTimeout dentro de detach exactamente una vez por creación', () => {
    let inside = false;
    const observed: boolean[] = [];
    const original = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      observed.push(inside);
      return original(callback, ms);
    }) as typeof setTimeout);
    let calls = 0;
    const detach = <T>(fn: () => T): T => {
      calls++;
      inside = true;
      try { return fn(); } finally { inside = false; }
    };
    const scope = registry({ detach }).createScope();
    const first = scope.setTimer(0, () => {});
    scope.setTimer(0, () => {});
    first.clear();
    jest.advanceTimersByTime(0);
    scope.dispose();
    scope.setTimer(0, () => {});
    expect(calls).toBe(2);
    expect(observed).toEqual([true, true]);
    const identity = registry().createScope();
    const fn = jest.fn();
    identity.setTimer(0, fn);
    jest.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([true, true, false]);
  });
  it('A: conserva el contexto sin detach y lo separa con detach usando temporizadores reales', async () => {
    jest.useRealTimers();
    realTimers = true;
    const als = new AsyncLocalStorage<{ x: number } | undefined>();
    const control = registry().createScope();
    const detached = registry({ detach: fn => als.run(undefined, fn) }).createScope();
    let safety: ReturnType<typeof setTimeout> | undefined;
    const settle: Array<() => void> = [];
    try {
      const observations = [control, detached].map(scope => new Promise<unknown>(resolve => {
        settle.push(() => resolve(undefined));
        als.run({ x: 1 }, () => scope.setTimer(1, () => resolve(als.getStore())));
      }));
      const timeout = new Promise<unknown[]>((resolve, reject) => {
        settle.push(() => resolve([]));
        safety = setTimeout(() => reject(new Error('La prueba de contexto excedió el plazo.')), 1000);
      });
      expect(await Promise.race([Promise.all(observations), timeout])).toEqual([{ x: 1 }, undefined]);
      expect(control.stats()).toMatchObject({ active: 0, fired: 1 });
      expect(detached.stats()).toMatchObject({ active: 0, fired: 1 });
    } finally {
      control.dispose();
      detached.dispose();
      if (safety !== undefined) clearTimeout(safety);
      for (const finish of settle) finish();
      als.disable();
      jest.useRealTimers();
    }
  });
  it('contrasta las estadísticas con un modelo aleatorio de semilla 0x715C', () => {
    const random = seeded(0x715C);
    const item = registry();
    const scopes = [item.createScope(), item.createScope(), item.createScope()];
    const model = scopes.map(() => ({ active: 0, created: 0, fired: 0, cleared: 0, callbackErrors: 0, handlerErrors: 0, rejectedAfterDispose: 0 }));
    const entries: Array<{ handle: TimerHandle; scope: number; due: number; active: boolean }> = [];
    let time = 0;
    for (let operation = 0; operation < 1200; operation++) {
      const index = Math.floor(random() * scopes.length);
      const action = random();
      if (action < 0.55) {
        const delay = 1 + Math.floor(random() * 100);
        const handle = scopes[index].setTimer(delay, () => {});
        entries.push({ handle, scope: index, due: time + delay, active: true });
        model[index].created++;
        model[index].active++;
      } else if (action < 0.75 && entries.length > 0) {
        const entry = entries[Math.floor(random() * entries.length)];
        entry.handle.clear();
        entry.handle.clear();
        if (entry.active) { entry.active = false; model[entry.scope].active--; model[entry.scope].cleared++; }
      } else {
        const advance = Math.floor(random() * 30);
        time += advance;
        for (const entry of entries) {
          if (entry.active && entry.due <= time) { entry.active = false; model[entry.scope].active--; model[entry.scope].fired++; }
        }
        jest.advanceTimersByTime(advance);
      }
      for (let scope = 0; scope < scopes.length; scope++) expect(scopes[scope].stats()).toEqual(model[scope]);
      expect(jest.getTimerCount()).toBe(model.reduce((sum, counts) => sum + counts.active, 0));
    }
    for (let index = 0; index < scopes.length; index++) {
      scopes[index].dispose();
      model[index].cleared += model[index].active;
      model[index].active = 0;
      expect(scopes[index].stats()).toEqual(model[index]);
    }
    const total = { ...model[0] };
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] = model.reduce((sum, counts) => sum + counts[key], 0);
    expect(item.stats()).toEqual(total);
    expect(new Set(scopes.map(scope => scope.id)).size).toBe(3);
    expect(new Set(entries.map(entry => entry.handle.id)).size).toBe(entries.length);
  });
});
