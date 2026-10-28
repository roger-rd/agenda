export interface ErrorResponse {
  error: { code: string; message: string; field?: string; requestId: string };
}
