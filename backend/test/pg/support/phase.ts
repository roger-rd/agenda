export type Phase = 'offline' | 'readonly' | 'dml';
export function parsePhase(value: unknown, nodeEnv: unknown): Phase {
  if (value === 'cleanup') throw new Error('fase cleanup requiere autorización específica');
  if (value !== 'offline' && value !== 'readonly' && value !== 'dml') {
    throw new Error('AGENDA_B2B_PHASE obligatoria: offline, readonly o dml (antes de importar pg/typeorm o leer DATABASE_*)');
  }
  if (nodeEnv !== 'test') throw new Error('NODE_ENV debe ser test');
  return value;
}
export function phaseEnvironment(phase: Phase, input: Record<string, string | undefined>): Record<string, string | undefined> {
  const output = { ...input };
  if (phase === 'readonly') output.PGOPTIONS = '-c default_transaction_read_only=on';
  else delete output.PGOPTIONS;
  return output;
}
