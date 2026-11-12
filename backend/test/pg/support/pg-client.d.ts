/** Minimal surface used by the readonly prototype guard; no driver replacement. */
declare module 'pg/lib/client' {
  class Client {
    query(this: unknown, ...args: unknown[]): unknown;
  }
  export = Client;
}
