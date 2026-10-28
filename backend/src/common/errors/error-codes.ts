export const statusErrors: Record<number, readonly [string, string]> = {
  400: ['invalid_input', 'Datos de entrada inválidos.'],
  401: ['unauthenticated', 'Autenticación requerida.'],
  403: ['forbidden', 'Acceso denegado.'],
  404: ['not_found', 'Recurso no encontrado.'],
  405: ['method_not_allowed', 'Método no permitido.'],
  409: ['conflict', 'Conflicto con el estado del recurso.'],
  413: ['payload_too_large', 'Cuerpo de solicitud demasiado grande.'],
  415: ['unsupported_media_type', 'Tipo de contenido no admitido.'],
  422: ['invalid_input', 'Datos de entrada inválidos.'],
  429: ['rate_limited', 'Demasiadas solicitudes.'],
  500: ['internal_error', 'Error interno del servidor.'],
  503: ['service_unavailable', 'Servicio no disponible.'],
};

export function mappedError(status: number): { status: number; code: string; message: string } {
  const normalized = Number.isInteger(status) && status >= 400 && status < 500 ? status : status === 503 ? 503 : 500;
  const [code, message] = statusErrors[normalized] ?? ['request_error', 'Solicitud no válida.'];
  return { status: normalized, code, message };
}
