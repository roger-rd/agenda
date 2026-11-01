import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

type Memory = { rss: number; heapUsed: number; arrayBuffers: number };
type Measurement = { before: Memory; peak: Memory; growth: Memory; bytes: number; elapsedMs: number; maxQueue: number; maxRetained: number; drains: number };
type Sample = { pipeline: Measurement; control: Measurement };
const fields = ['rss', 'heapUsed', 'arrayBuffers'] as const;

// Validate AND reconstruct: diagnostics never echo arbitrary child output.
function measurement(value: unknown): Measurement {
  if (!value || typeof value !== 'object') throw new Error('invalid benchmark');
  const record = value as Record<string, unknown>;
  const numeric = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('invalid benchmark');
    return v;
  };
  const memory = (v: unknown): Memory => {
    if (!v || typeof v !== 'object') throw new Error('invalid benchmark');
    const m = v as Record<string, unknown>;
    return { rss: numeric(m.rss), heapUsed: numeric(m.heapUsed), arrayBuffers: numeric(m.arrayBuffers) };
  };
  return { before: memory(record.before), peak: memory(record.peak), growth: memory(record.growth), bytes: numeric(record.bytes), elapsedMs: numeric(record.elapsedMs), maxQueue: numeric(record.maxQueue), maxRetained: numeric(record.maxRetained), drains: numeric(record.drains) };
}
function samples(value: unknown): Sample[] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('invalid benchmark');
  return value.map((s: unknown) => {
    if (!s || typeof s !== 'object') throw new Error('invalid benchmark');
    const pair = s as Record<string, unknown>;
    return { pipeline: measurement(pair.pipeline), control: measurement(pair.control) };
  });
}

/** Live peaks are collected after GC at every observation in an isolated child.
 * Minimum of three samples reduces allocator noise. Exactly +32 MiB over control
 * and 64 MiB absolute allow overhead without accepting excessive retained memory.
 * A SEPARATE no-GC workload reports allocation pressure, purely informational.
 * Invalid JSON, child errors and timeouts fail closed without echoing child output. */
export function checkIsolatedMemory(mode: 'redactor' | 'stream') {
  const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'memory-bench.cjs'), mode], {
    env: {}, shell: false, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
  });
  const state = { mode, exitCode: child.status, signal: child.signal, childFailed: Boolean(child.error || child.status !== 0 || child.signal) };
  if (state.childFailed) {
    process.stdout.write('MEMORY_BENCH ' + JSON.stringify(state) + '\n');
    throw new Error('Isolated memory benchmark failed');
  }
  let live: Sample[]; let allocationPressureInformative: Sample[];
  try {
    const result = JSON.parse(child.stdout) as Record<string, unknown>;
    if (result.mode !== mode) throw new Error('invalid benchmark');
    live = samples(result.live);
    allocationPressureInformative = samples(result.allocationPressureInformative);
  } catch {
    process.stdout.write('MEMORY_BENCH ' + JSON.stringify({ ...state, invalidResult: true }) + '\n');
    throw new Error('Isolated memory benchmark invalid result');
  }
  const thresholds = fields.map(key => {
    const pipeline = Math.min(...live.map(sample => sample.pipeline.growth[key]));
    const control = Math.min(...live.map(sample => sample.control.growth[key]));
    return { withinControl: pipeline <= control + 32 * 1024 * 1024, withinAbsolute: pipeline <= 64 * 1024 * 1024 };
  });
  // Diagnostic MUST precede every threshold assertion, including deterministic ones.
  process.stdout.write('MEMORY_BENCH ' + JSON.stringify({ ...state, live, allocationPressureInformative, thresholds }) + '\n');
  for (const sample of [...live, ...allocationPressureInformative]) for (const m of [sample.pipeline, sample.control]) {
    expect(m.bytes).toBe(10 * 1024 * 1024);
    expect(m.elapsedMs).toBeLessThan(5000);
    expect(m.maxQueue).toBeLessThanOrEqual(128 * 1024);
    expect(m.maxRetained).toBeLessThanOrEqual(4096);
    expect(m.drains).toBeGreaterThanOrEqual(160);
    for (const key of fields) expect(m.growth[key]).toBe(m.peak[key] - m.before[key]);
  }
  for (const threshold of thresholds) {
    expect(threshold.withinControl).toBe(true);
    expect(threshold.withinAbsolute).toBe(true);
  }
}
