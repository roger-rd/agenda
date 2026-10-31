import { buildSummary, validateSummary, formatSummaryLine, STATUS_EXITS } from '../../scripts/harness/summary.cjs';
import { CATALOG } from '../../scripts/harness/harness-error.cjs';
import { EXIT, SUMMARY_PHASES, SUMMARY_PREFIX } from '../../scripts/harness/constants.cjs';
import { APP_SECRET } from './support/synthetic-secrets';

const input = { mode: 'fast', status: 'not_ready', exitCode: 2, code: 'H-C8-PENDING', phase: 'c8-gate', durationMs: 0 };
describe('resumen (UN-D7 parcial)', () => {
  it('produce el esquema exacto, congelado y determinista', () => {
    const summary = buildSummary(input);
    expect(summary).toEqual({ schemaVersion: 1, tool: 'test-db', ...input });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(formatSummaryLine(summary)).toBe(SUMMARY_PREFIX +
      '{"schemaVersion":1,"tool":"test-db","mode":"fast","status":"not_ready","exitCode":2,"code":"H-C8-PENDING","phase":"c8-gate","durationMs":0}');
    expect(formatSummaryLine(summary)).not.toMatch(/[\r\n]/);
    expect(formatSummaryLine(summary)).not.toContain(APP_SECRET);
    const reverse = Object.fromEntries(Object.entries(summary).reverse());
    expect(formatSummaryLine(reverse)).toBe(formatSummaryLine(summary));
  });
  it('documenta y comprueba la tabla completa status ↔ exitCode', () => {
    expect(STATUS_EXITS).toEqual({ ok: [0], not_ready: [2], failed: [1], aborted: [130, 143], error: [3, 4] });
    for (const [status, allowed] of Object.entries(STATUS_EXITS)) {
      expect(Object.isFrozen(allowed)).toBe(true);
      for (const exitCode of Object.values(EXIT)) {
        const make = () => buildSummary({ ...input, status, exitCode });
        if (allowed.includes(exitCode)) expect(make).not.toThrow();
        else expect(make).toThrow(expect.objectContaining({ code: 'H-SUMMARY-INVALID' }));
      }
    }
  });
  it.each(SUMMARY_PHASES)('acepta fase %s', phase => {
    expect(() => buildSummary({ ...input, phase, mode: 'slow', code: null, durationMs: 86400000 })).not.toThrow();
  });
  it.each(Object.keys(CATALOG))('acepta código de catálogo %s como dato', code => {
    expect(buildSummary({ ...input, code }).code).toBe(code);
  });
  it.each([
    { schemaVersion: 2 }, { schemaVersion: '1' }, { tool: 'other' }, { mode: 'FAST' }, { status: 'unknown' },
    { phase: 'unknown' }, { exitCode: '2' }, { exitCode: 2.5 }, { exitCode: 99 }, { code: APP_SECRET },
    { code: 1 }, { code: undefined }, { durationMs: -1 }, { durationMs: 86400001 }, { durationMs: 0.1 },
    { durationMs: NaN }, { durationMs: Infinity }, { durationMs: '0' }, { extra: APP_SECRET },
    { [Symbol('extra')]: 'bad' }, { mode: 'fast\n' }, { phase: null },
  ])('rechaza tipos, rangos, texto libre y extras %#', patch => {
    const summary = { ...buildSummary(input), ...patch };
    expect(() => validateSummary(summary)).toThrow(expect.objectContaining({ code: 'H-SUMMARY-INVALID' }));
    expect(() => formatSummaryLine(summary)).toThrow(expect.objectContaining({ code: 'H-SUMMARY-INVALID' }));
  });
  it.each(Object.keys(buildSummary(input)))('rechaza ausencia de %s', key => {
    const summary: Record<string, unknown> = { ...buildSummary(input) };
    delete summary[key];
    expect(() => validateSummary(summary)).toThrow();
  });
  it.each([null, undefined, [], 1, 'free text'])('rechaza entrada no estructurada %#', summary => {
    expect(() => validateSummary(summary)).toThrow(expect.objectContaining({ code: 'H-SUMMARY-INVALID' }));
  });
  it('rechaza extras en buildSummary y getters sin evaluarlos en validateSummary', () => {
    expect(() => buildSummary({ ...input, ...{ password: APP_SECRET } })).toThrow();
    const get = jest.fn(() => 'fast');
    expect(() => validateSummary(Object.defineProperty({ ...buildSummary(input) }, 'mode', { get }))).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
