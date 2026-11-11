import type { Request, Response } from 'express';
import { securityHeaders } from './security-headers';
it('middleware aplica cinco cabeceras sin HSTS', () => {
  const setHeader = jest.fn(); const next = jest.fn();
  securityHeaders({} as Request, { setHeader } as unknown as Response, next);
  expect(setHeader).toHaveBeenCalledTimes(5); expect(next).toHaveBeenCalledTimes(1);
  expect(setHeader.mock.calls.some(([name]) => name === 'Strict-Transport-Security')).toBe(false);
});
