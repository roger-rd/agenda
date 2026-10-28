import { inspect } from 'node:util';
import { registerSecret } from '../logging/secret-registry';
import { registerSafeSerializer } from '../logging/error-sanitizer';

export class DatabaseCredentials {
  readonly #password: string;
  readonly #release: () => void;

  constructor(readonly user: string, password: string) {
    this.#release = registerSecret(password);
    this.#password = password;
    Object.freeze(this);
  }

  // Las credenciales de runtime viven lo que el proceso. Quien las reemplace
  // DEBE llamar a dispose() de las antiguas; revelar la clave sigue permitido.
  dispose(): void { this.#release(); }

  // Solo para la futura fábrica del DataSource.
  revealPassword(): string { return this.#password; }
  toString(): string { return `${this.user}:[REDACTED]`; }
  toJSON() { return { user: this.user, password: '[REDACTED]' }; }
  [inspect.custom](): string { return this.toString(); }
}

export class DatabaseConnectionConfig {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly name: string,
    readonly credentials: DatabaseCredentials,
    readonly poolMax: number,
  ) { Object.freeze(this); }

  describe(): string { return `${this.credentials.user}@${this.host}:${this.port}/${this.name}`; }
  toJSON() {
    return { host: this.host, port: this.port, name: this.name,
      credentials: this.credentials.toJSON(), poolMax: this.poolMax };
  }
  [inspect.custom](): string { return this.describe(); }
}

registerSafeSerializer(DatabaseCredentials, (c: DatabaseCredentials) => c.toJSON());
registerSafeSerializer(DatabaseConnectionConfig, (c: DatabaseConnectionConfig) => c.toJSON());
