import { types } from 'node:util';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { own, markSafeHttpOutput, inspectable, resolveDescriptor } from './error-sanitizer';
import { scrubText } from './secret-registry';
import { safeLogging, extraRedactPaths } from './safe-logging';
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

// Excepción acotada: getter nativo capturado; nunca se lee socket.remoteAddress,
// que podría estar reemplazado por un accesor propio hostil.
const REMOTE_ADDRESS_GET = Object.getOwnPropertyDescriptor(Socket.prototype, 'remoteAddress')?.get;
const HANDLE_DESCRIPTOR = Object.getOwnPropertyDescriptor(Socket.prototype, '_handle');
const GET_PEERNAME = Object.getOwnPropertyDescriptor(Socket.prototype, '_getpeername')?.value as unknown;
function genuineSocket(socket: unknown): socket is Socket {
  if (!socket || typeof socket !== 'object' || types.isProxy(socket)) return false;
  const prototype: unknown = Object.getPrototypeOf(socket);
  if (prototype !== Socket.prototype && prototype !== TLSSocket.prototype) return false;
  const peername = resolveDescriptor(socket, '_getpeername');
  if (!peername || !('value' in peername) || typeof GET_PEERNAME !== 'function' || peername.value !== GET_PEERNAME) return false;
  for (const key of ['_peername', 'connecting']) {
    const d = resolveDescriptor(socket, key);
    if (d === null || (d !== undefined && !('value' in d))) return false;
  }
  const descriptor = resolveDescriptor(socket, '_handle');
  if (descriptor === null) return false;
  let handle: unknown;
  if (descriptor && 'value' in descriptor) handle = descriptor.value;
  else if (descriptor) {
    // Node 24 guarda el handle detrás de este accesor del prototipo.
    // Solo se admite el par getter/setter capturado, nunca un reemplazo.
    if (!HANDLE_DESCRIPTOR || 'value' in HANDLE_DESCRIPTOR || typeof HANDLE_DESCRIPTOR.get !== 'function' ||
      descriptor.get !== HANDLE_DESCRIPTOR.get || descriptor.set !== HANDLE_DESCRIPTOR.set) return false;
    try { handle = HANDLE_DESCRIPTOR.get.call(socket); }
    catch { return false; }
  }
  if (handle !== null && handle !== undefined) {
    if (typeof handle !== 'object' || types.isProxy(handle)) return false;
    const method = resolveDescriptor(handle, 'getpeername');
    if (!method || !('value' in method) || typeof method.value !== 'function' || types.isProxy(method.value) ||
      !Function.prototype.toString.call(method.value).includes('[native code]')) return false;
    // Riesgo residual: una función enlazada con bind también parece nativa;
    // aprovecharlo exige código hostil ejecutándose dentro del proceso.
  }
  return true;
}
function readRemoteAddress(req: object): unknown {
  try {
    if (!inspectable(req) || !(req instanceof IncomingMessage)) return undefined;
    const socket = own(req, 'socket');
    if (!genuineSocket(socket)) return undefined;
    return REMOTE_ADDRESS_GET?.call(socket);
  } catch { return undefined; }
}

const requests = new WeakSet<object>();
const responses = new WeakSet<object>();
export function serializeRequest(req: unknown): object {
  try {
    if (!req || typeof req !== 'object' || types.isProxy(req)) return {};
    if (requests.has(req)) return req;
    const result: Record<string, unknown> = {};
    const id = own(req, 'id'), method = own(req, 'method'), url = own(req, 'url');
    const remoteAddress = readRemoteAddress(req);
    if (typeof id === 'string' && id.length <= 80) result.id = scrubText(id, 80);
    if (typeof method === 'string' && /^[A-Z]{3,10}$/.test(method) && !/[\r\n]/.test(method)) result.method = method;
    if (typeof url === 'string' && url.length <= 8192) result.url = scrubText(sanitizeUrl(url), 8192);
    if (typeof remoteAddress === 'string' && remoteAddress.length <= 64) result.remoteAddress = scrubText(remoteAddress, 64);
    requests.add(result);
    return markSafeHttpOutput(result);
  } catch { return {}; }
}
export function serializeResponse(res: unknown): object {
  try {
    if (!res || typeof res !== 'object' || types.isProxy(res)) return {};
    if (responses.has(res)) return res;
    const statusCode = own(res, 'statusCode');
    const result = typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {};
    responses.add(result);
    return markSafeHttpOutput(result);
  } catch { return {}; }
}

export function createLoggerOptions(
  config: Pick<AppConfigService, 'logLevel'>,
  stream?: Writable,
  ids: IdGenerator = new Uuid7Generator(),
): Options {
  const sensitive = ['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey', 'cookie', 'DATABASE_PASSWORD', 'DATABASE_MIGRATION_PASSWORD', 'databasePassword', 'connectionString', 'credentials'];
  return {
    ...safeLogging,
    level: config.logLevel,
    ...(stream ? { stream } : {}),
    redact: {
      censor: '[REDACTED]',
      paths: [
        ...extraRedactPaths,
        'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'req.headers["x-csrf-token"]', 'req.headers["x-api-key"]',
        // Hasta cuatro objetos contenedores, incluyendo arrays.
        ...sensitive.flatMap(key => Array.from({ length: 5 }, (_, depth) => `${'*.'.repeat(depth)}${key}`)),
      ],
    },
    wrapSerializers: false,
    serializers: {
      ...safeLogging.serializers,
      req: serializeRequest,
      res: serializeResponse,
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
