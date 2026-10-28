import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import type { Options } from 'pino-http';
import type { AppConfigService } from '../config/app-config.service';
import { IdGenerator } from '../common/ids/id-generator';
import { Uuid7Generator } from '../common/ids/uuid7-generator';

export function sanitizeUrl(url: string): string {
  return url.split(/[?#]/, 1)[0].split('/').map(segment => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return '[REDACTED]'; }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return /^[A-Za-z0-9_-]{24,}$/.test(decoded) && !uuid.test(decoded) ? '[REDACTED]' : segment;
  }).join('/');
}

export function requestId(value: unknown, ids: IdGenerator): string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : ids.next();
}

export function createLoggerOptions(
  config: Pick<AppConfigService, 'logLevel'>,
  stream?: Writable,
  ids: IdGenerator = new Uuid7Generator(),
): Options {
  const sensitive = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'cookie'];
  return {
    level: config.logLevel,
    ...(stream ? { stream } : {}),
    redact: {
      censor: '[REDACTED]',
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'req.headers["x-csrf-token"]', 'req.headers["x-api-key"]',
        // Hasta cuatro objetos contenedores, incluyendo arrays.
        ...sensitive.flatMap(key => Array.from({ length: 5 }, (_, depth) => `${'*.'.repeat(depth)}${key}`)),
      ],
    },
    wrapSerializers: false,
    serializers: {
      req: (req: IncomingMessage) => ({ id: req.id, method: req.method,
        url: sanitizeUrl(req.url ?? '/'), remoteAddress: req.socket.remoteAddress }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    genReqId: (req, res) => {
      const id = requestId(req.headers['x-request-id'], ids);
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customErrorObject: (_req, res) => ({ res: { statusCode: res.statusCode } }),
    customErrorMessage: () => 'Solicitud finalizada.',
    customSuccessMessage: () => 'Solicitud finalizada.',
  };
}
