import { Writable } from 'node:stream';

// Pure module (no Nest or config imports): testable offline.
/** In-memory destination for the application logs of the invitations phase. */
export class LogCapture {
  static readonly LIMIT = 16 * 1024 * 1024;
  private chunks: string[] = [];
  private size = 0;
  private over = false;
  readonly stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      const text = String(chunk);
      if (this.size + text.length > LogCapture.LIMIT) this.over = true;
      else { this.chunks.push(text); this.size += text.length; }
      done();
    },
  });
  text(): string { return this.chunks.join(''); }
  /** True when the capture could not keep everything: an absence check over it would prove nothing. */
  overflowed(): boolean { return this.over; }
  reset(): void { this.chunks = []; this.size = 0; this.over = false; }
}
