import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExpressAdapter } from '@nestjs/platform-express';
import { json } from 'express';
import { setupHttpLogging } from '../../logging/setup-http-logging';
import { securityHeaders } from './security-headers';
import { createValidationPipe } from './validation.pipe';
import { JsonBodyGuard } from './content-type';

/** Llamar antes de init/listen: el logging debe preceder al parser. */
export async function configureHttpApp(app: INestApplication): Promise<void> {
  app.setGlobalPrefix('api/v1');
  const adapter = app.getHttpAdapter() as ExpressAdapter;
  adapter.getInstance().disable('x-powered-by');
  // Nest 12 limita el 404 al prefijo. Esta app ocupa todo el servidor:
  // registrar su proxy (con filtros) en la raíz, después de las rutas de Nest.
  const setNotFoundHandler = adapter.setNotFoundHandler.bind(adapter);
  adapter.setNotFoundHandler = handler => setNotFoundHandler(handler);
  app.use(securityHeaders);
  await setupHttpLogging(app);
  app.use(json({ limit: '100kb' }));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalGuards(new JsonBodyGuard(app.get(Reflector)));
}
