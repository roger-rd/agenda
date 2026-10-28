import { inspect } from 'node:util';

export class DatabaseCredentials {
  readonly #password: string;

  constructor(readonly user: string, password: string) {
    this.#password = password;
    Object.freeze(this);
  }

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
