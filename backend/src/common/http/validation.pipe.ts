import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import { InvalidInputError } from '../errors/domain-error';

class HttpValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const declared = new Set(metadata.metatype
      ? getMetadataStorage().getTargetValidationMetadatas(metadata.metatype, '', false, false).map(entry => entry.propertyName)
      : []);
    // Una instancia por invocación evita compartir metadatos entre solicitudes concurrentes.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
      exceptionFactory: errors => {
        const unknown = errors.some(error => error.constraints?.whitelistValidation);
        const field = unknown ? undefined : errors.map(error => error.property).find(property => declared.has(property));
        return new InvalidInputError('Datos de entrada inválidos.', field);
      },
    });
    return pipe.transform(value, metadata);
  }
}
export function createValidationPipe(): ValidationPipe { return new HttpValidationPipe(); }
