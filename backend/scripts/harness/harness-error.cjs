'use strict';

const CATALOG = Object.freeze({
  'H-ARGS': 'Argumentos inválidos.', 'H-PLATFORM': 'Plataforma no compatible.',
  'H-PACKAGE': 'Paquete no válido.', 'H-C8-PENDING': 'Contrato C8 pendiente.',
  'H-ENV-PERM': 'Permisos de entorno no válidos.', 'H-ENV-LINK': 'Enlace de entorno no permitido.',
  'H-ENV-TYPE': 'Tipo de fichero no permitido.', 'H-ENV-OWNER': 'Propietario de entorno no válido.',
  'H-ENV-SIZE': 'Límite de entorno excedido.', 'H-ENV-READ': 'No se pudo leer el entorno.',
  'H-ENV-ENCODING': 'Codificación de entorno no válida.', 'H-ENV-PARSE': 'Análisis de entorno inconsistente.',
  'H-ENV-DUP': 'Clave de entorno duplicada.', 'H-ENV-KEY': 'Clave de entorno obligatoria ausente.',
  'H-ENV-VALUE': 'Valor de entorno no válido.', 'H-ENV-MISMATCH': 'Entornos incompatibles.',
  'H-TOKEN-FORMAT': 'Formato de testigo no válido.', 'H-TOKEN-EXPIRED': 'Testigo caducado.',
  'H-TOKEN-FUTURE': 'Testigo emitido en el futuro.', 'H-CHILD-TMPDIR': 'Directorio temporal no válido.',
  'H-CHILD-ENV': 'Entorno de hijo no válido.', 'H-SUMMARY-INVALID': 'Resumen no válido.',
  'H-RDX-EMPTY': 'Secreto vacío.', 'H-RDX-SHORT': 'Secreto demasiado corto.',
  'H-RDX-1': 'Fallo de protección de secretos.', 'H-RDX-2': 'Fallo de protección de secretos.',
  'H-RDX-3': 'Fallo de protección de secretos.', 'H-RDX-4': 'Fallo de protección de secretos.',
  'H-SCAN-HIT': 'Inspección de secretos fallida.', 'H-GRP-LEAK': 'Grupo de procesos residual.',
  'H-WATCHDOG': 'Tiempo máximo excedido.',
  // Diagnósticos reservados: su comportamiento pertenece a B2.
  'W-1': 'Fallo interno del envoltorio.', 'W-2': 'Fallo interno del envoltorio.',
  'W-3': 'Fallo interno del envoltorio.', 'W-4': 'Fallo interno del envoltorio.',
});
const STRING_FIELDS = Object.freeze(['host', 'database', 'role', 'schema', 'phase', 'sqlstate', 'mode', 'file', 'key']);
const INTEGER_FIELDS = Object.freeze(['port', 'count', 'durationMs', 'line', 'bytes']);
/** @typedef {keyof typeof CATALOG} ErrorCode */
/** @typedef {Readonly<Record<string, string | number>>} ErrorFields */

class HarnessError extends Error {
  /** @param {string} code @param {Record<string, unknown>} [fields] */
  constructor(code, fields = {}) {
    if (!Object.hasOwn(CATALOG, code)) throw new TypeError(CATALOG['H-ARGS']);
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError(CATALOG['H-ARGS']);
    /** @type {Record<string, string | number>} */
    const safe = {};
    for (const key of Reflect.ownKeys(fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(fields, key);
      if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(CATALOG['H-ARGS']);
      const value = descriptor.value;
      if (STRING_FIELDS.includes(key) && typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value)) safe[key] = value;
      else if (INTEGER_FIELDS.includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      else throw new TypeError(CATALOG['H-ARGS']);
    }
    super(CATALOG[/** @type {ErrorCode} */ (code)]);
    this.name = 'HarnessError';
    this.code = /** @type {ErrorCode} */ (code);
    this.fields = Object.freeze(safe);
    Object.freeze(this);
  }
  /** @returns {Readonly<{code: ErrorCode, fields: ErrorFields}>} */
  toJSON() { return Object.freeze({ code: this.code, fields: this.fields }); }
  /** Traducción por código; nunca recibe el error de origen.
   * @param {string} code @param {Record<string, unknown>} [fields] @returns {HarnessError} */
  static translate(code, fields) { return new HarnessError(code, fields); }
}
Object.freeze(HarnessError.prototype);
Object.freeze(HarnessError);
module.exports = Object.freeze({ HarnessError, CATALOG });
