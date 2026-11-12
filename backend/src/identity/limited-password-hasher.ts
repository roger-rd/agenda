import { ServiceUnavailableError } from '../common/errors/domain-error';
import { PasswordHasher } from './password-hasher';

export const PASSWORD_HASH_CONCURRENCY = Object.freeze({ active: 4, queued: 32 });

export class LimitedPasswordHasher extends PasswordHasher {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly inner: PasswordHasher,
    private readonly activeLimit: number = PASSWORD_HASH_CONCURRENCY.active,
    private readonly queueLimit: number = PASSWORD_HASH_CONCURRENCY.queued,
  ) {
    super();
    if (!Number.isInteger(activeLimit) || activeLimit < 1 ||
        !Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new RangeError('Límites de concurrencia inválidos.');
    }
  }

  hash(password: unknown): Promise<string> {
    return this.run(() => this.inner.hash(password));
  }

  verify(phc: unknown, password: unknown): Promise<boolean> {
    return this.run(() => this.inner.verify(phc, password));
  }

  needsRehash(phc: unknown): boolean {
    return this.inner.needsRehash(phc);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.activeLimit) {
      this.active++;
    } else {
      if (this.queue.length >= this.queueLimit) throw new ServiceUnavailableError(undefined, 1);
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    try {
      return await operation();
    } finally {
      // Transferir el cupo reservado antes de permitir nuevas admisiones.
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
