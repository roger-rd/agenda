import { RECOVERY_ROUTES } from '../../platform/routes';

export const SIMULATION_NOTE = 'Simulación: no se envía ningún correo ni se guarda ninguna contraseña. Esta demostración no usa contraseñas.';
export const CONFIRMATION_MESSAGE = 'Si el correo corresponde a una cuenta, recibirás instrucciones para restablecer el acceso.';
export const SUCCESS_MESSAGE = 'Contraseña actualizada (simulación). No se guardó ninguna contraseña: esta demostración no las usa.';
export const RECOVERY_TITLES = {
  request: 'Recuperar acceso',
  sent: 'Instrucciones de recuperación',
  reset: 'Crear nueva contraseña (demostración)',
} as const;
export const normalizeEmail = (raw: string) => raw.trim().toLowerCase();
export function validateEmail(raw: string) {
  const email = normalizeEmail(raw);
  if (!email) return 'Escribe tu correo.';
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return 'Escribe un correo válido, por ejemplo nombre@dominio.com.';
  return '';
}
export function requestRecovery(raw: string) {
  const error = validateEmail(raw);
  return error ? { error } : { error: '', destination: RECOVERY_ROUTES.sent, message: CONFIRMATION_MESSAGE };
}
export function validatePasswords(password: string, repeated: string) {
  return {
    password: password.length < 8 ? 'Usa al menos 8 caracteres.' : '',
    repeated: !repeated ? 'Repite la contraseña.' : password !== repeated ? 'Las contraseñas deben coincidir.' : '',
  };
}
