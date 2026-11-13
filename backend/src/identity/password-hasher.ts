import { Injectable } from '@nestjs/common';
import { hash, parseOptions, verify, type ParsedHashOptions } from '@node-rs/argon2';
import { InvalidInputError, ServiceUnavailableError } from '../common/errors/domain-error';
import { preparePassword } from './password-policy';

// Literales para los declare const enum: Argon2id=2, V0x13=1 (PHC v=19).
export const PASSWORD_HASH_POLICY = Object.freeze({
  algorithm: 2, version: 1, memoryCost: 19456, timeCost: 2,
  parallelism: 1, outputLen: 32, saltLen: 16,
} as const);

export abstract class PasswordHasher {
  abstract hash(password: unknown): Promise<string>;
  abstract verify(phc: unknown, password: unknown): Promise<boolean>;
  /** Solo llamar tras una verificación exitosa; un PHC inválido devuelve false. */
  abstract needsRehash(phc: unknown): boolean;
}

const PHC = /^\$argon2id\$v=19\$m=([1-9]\d*),t=([1-9]\d*),p=([1-9]\d*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)(?![\s\S])/;

function validatedOptions(phc: unknown): ParsedHashOptions | null {
  if (typeof phc !== 'string' || phc.length < 40 || phc.length > 512) return null;
  const match = PHC.exec(phc);
  if (!match) return null;
  const [, m, t, p, salt, output] = match;
  const memoryCost = Number(m), timeCost = Number(t), parallelism = Number(p);
  if (memoryCost < 19456 || memoryCost > 65536 || timeCost < 2 || timeCost > 4 || parallelism !== 1) return null;
  if (salt.length !== 22 || output.length !== 43) return null;
  const saltBytes = Buffer.from(salt, 'base64'), outputBytes = Buffer.from(output, 'base64');
  if (saltBytes.length !== 16 || outputBytes.length !== 32) return null;
  // Exigir codificación canónica también rechaza bits de relleno no nulos.
  if (saltBytes.toString('base64').replace(/=+$/, '') !== salt ||
      outputBytes.toString('base64').replace(/=+$/, '') !== output) return null;
  try {
    const options = parseOptions(phc);
    if (options.algorithm !== 2 || options.version !== 1 || options.memoryCost !== memoryCost ||
        options.timeCost !== timeCost || options.parallelism !== parallelism ||
        options.saltLen !== 16 || options.outputLen !== 32) return null;
    return options;
  } catch { return null; }
}

@Injectable()
export class Argon2idPasswordHasher extends PasswordHasher {
  async hash(password: unknown): Promise<string> {
    const prepared = preparePassword(password);
    if (!prepared.ok) throw new InvalidInputError('Contraseña inválida.');
    try {
      // Omitir salt: la biblioteca genera una sal aleatoria de 16 bytes.
      return await hash(prepared.value, PASSWORD_HASH_POLICY);
    } catch { throw new ServiceUnavailableError(); }
  }

  async verify(phc: unknown, password: unknown): Promise<boolean> {
    if (!validatedOptions(phc)) return false;
    const prepared = preparePassword(password);
    if (!prepared.ok) return false;
    try {
      return await verify(phc as string, prepared.value);
    } catch { throw new ServiceUnavailableError(); }
  }

  needsRehash(phc: unknown): boolean {
    const options = validatedOptions(phc);
    return options !== null && (options.memoryCost !== PASSWORD_HASH_POLICY.memoryCost ||
      options.timeCost !== PASSWORD_HASH_POLICY.timeCost || options.parallelism !== PASSWORD_HASH_POLICY.parallelism);
  }
}
