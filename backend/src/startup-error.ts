import { EnvironmentValidationError } from './config/env.validation';

export function startupErrorMessage(error: unknown): string {
  if (error instanceof EnvironmentValidationError) return error.message;
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) {
      return `No se pudo iniciar el servidor (${code}).`;
    }
  }
  return 'No se pudo iniciar el servidor.';
}
