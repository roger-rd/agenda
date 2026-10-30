export interface TimerHandle { readonly id: number; readonly active: boolean; clear(): void }
export interface TimerOptions { readonly unref?: boolean }
export interface TimerErrorEvent { readonly scopeId: number; readonly timerId: number; readonly error: unknown }
export interface TimerRegistryOptions {
  readonly detach?: <T>(fn: () => T) => T;
  readonly onCallbackError?: (event: TimerErrorEvent) => void | PromiseLike<void>;
}
export interface TimerStats {
  readonly active: number;
  readonly created: number;
  readonly fired: number;
  readonly cleared: number;
  readonly callbackErrors: number;
  readonly handlerErrors: number;
  readonly rejectedAfterDispose: number;
}
type Counters = { -readonly [Key in keyof TimerStats]: number };
function counters(): Counters {
  return { active: 0, created: 0, fired: 0, cleared: 0, callbackErrors: 0, handlerErrors: 0, rejectedAfterDispose: 0 };
}
const INERT_HANDLE: TimerHandle = Object.freeze({ id: -1, active: false, clear: () => {} });

// El manejador de rechazo no lanza y cada invocación informa como máximo un error.
function invokeSafely(fn: () => unknown, onError: (error: unknown) => void): void {
  let counted = false;
  const reject = (error: unknown): void => {
    if (counted) return;
    counted = true;
    onError(error);
  };
  try {
    const result = fn();
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then: unknown = (result as { then?: unknown }).then;
      if (typeof then === 'function') {
        const returned: unknown = then.call(result, undefined, reject);
        // Un thenable ajeno puede devolver una promesa rechazada independiente.
        // La promesa derivada de esta observación queda resuelta: reject nunca lanza.
        if (returned instanceof Promise) Promise.prototype.then.call(returned, undefined, reject);
      }
    }
  } catch (error) { reject(error); }
}

export class TimerRegistry {
  private readonly options: TimerRegistryOptions;
  private readonly totals = counters();
  private nextScopeId = 1;
  private nextTimerId = 1;
  constructor(options: TimerRegistryOptions = {}) {
    if (options.onCallbackError !== undefined && typeof options.onCallbackError !== 'function') {
      throw new TypeError('Manejador de errores de temporizador inválido.');
    }
    this.options = Object.freeze({ ...options });
  }
  createScope(): TimerScope {
    return new TimerScope(this.nextScopeId++, this.options, this.totals, () => this.nextTimerId++);
  }
  stats(): TimerStats { return Object.freeze({ ...this.totals }); }
}

export class TimerScope {
  readonly id: number;
  private closed = false;
  private readonly options: TimerRegistryOptions;
  private readonly totals: Counters;
  private readonly counts = counters();
  private readonly allocateId: () => number;
  private readonly handles = new Map<number, TimerHandle>();

  constructor(id: number, options: TimerRegistryOptions, totals: Counters, allocateId: () => number) {
    this.id = id;
    this.options = options;
    this.totals = totals;
    this.allocateId = allocateId;
  }
  get disposed(): boolean { return this.closed; }
  private increment(key: keyof TimerStats, amount = 1): void {
    this.counts[key] += amount;
    this.totals[key] += amount;
  }
  stats(): TimerStats { return Object.freeze({ ...this.counts }); }
  setTimer(ms: number, fn: () => void | PromiseLike<void>, options: TimerOptions = {}): TimerHandle {
    if (this.closed) {
      this.increment('rejectedAfterDispose');
      return INERT_HANDLE;
    }
    if (!Number.isInteger(ms) || ms < 0 || ms > 2147483647) throw new TypeError('Plazo de temporizador inválido.');
    const id = this.allocateId();
    let active = true;
    const finish = (kind: 'fired' | 'cleared'): void => {
      active = false;
      this.handles.delete(id);
      this.increment('active', -1);
      this.increment(kind);
    };
    const wrapper = (): void => {
      if (this.closed || !active) return;
      finish('fired');
      invokeSafely(fn, error => {
        this.increment('callbackErrors');
        const hook = this.options.onCallbackError;
        if (hook) invokeSafely(() => hook({ scopeId: this.id, timerId: id, error }), () => this.increment('handlerErrors'));
      });
    };
    const detach = this.options.detach ?? (<T>(operation: () => T): T => operation());
    const timer = detach(() => setTimeout(wrapper, ms));
    const handle: TimerHandle = Object.freeze({
      id,
      get active() { return active; },
      clear: () => {
        if (!active) return;
        clearTimeout(timer);
        finish('cleared');
      },
    });
    this.handles.set(id, handle);
    this.increment('created');
    this.increment('active');
    if (options.unref) timer.unref();
    return handle;
  }
  /** No puede detenerse el trabajo asíncrono de un callback que ya había empezado. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.handles.values()) handle.clear();
    this.handles.clear();
  }
}
