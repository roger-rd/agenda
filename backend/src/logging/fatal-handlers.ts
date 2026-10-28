interface FatalLogger { fatal(data: object, message: string): void }
interface ProcessEvents {
  on(event: string, listener: (reason: unknown) => void): unknown;
  removeListener(event: string, listener: (reason: unknown) => void): unknown;
  exit(code: number): void;
}

export function installFatalHandlers(logger: FatalLogger, emitter: ProcessEvents = process): () => void {
  const handlers = (['unhandledRejection', 'uncaughtException'] as const).map(event => {
    const listener = (reason: unknown) => {
      try { logger.fatal({ event, err: reason }, 'Fallo fatal del proceso.'); }
      catch { /* El registro nunca impide salir. */ }
      finally { emitter.exit(1); }
    };
    emitter.on(event, listener);
    return { event, listener };
  });
  return () => handlers.forEach(({ event, listener }) => emitter.removeListener(event, listener));
}
