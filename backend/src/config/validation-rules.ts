import { isIP } from 'node:net';

export class EnvironmentValidationError extends Error {}

export const hostValidator = {
  validate: (value: unknown) => typeof value === 'string' && value.length <= 253 &&
    (isIP(value) !== 0 || (!/^[\d.]+$/.test(value) && value.split('.').every(
      label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))),
  defaultMessage: () => 'debe ser un hostname o IP válido, sin espacios',
};
