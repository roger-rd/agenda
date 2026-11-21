import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { SafeTypeOrmLogger } from '../safe-typeorm-logger';
import { loadOwnerConfiguration, type CredentialFs } from './credential-file';
import { authorize, parseArguments } from './schema-guards';
import { createSchemaDataSourceOptions } from './schema-data-source';
import { refusal, runSchema, summaryOf, type RunResult, type RunnerCode, type SchemaPort, type Timers } from './schema-runner';
import { BUDGET, SchemaRunnerError, SUMMARY_PREFIX, type SchemaCommand } from './schema-target';
import { createTypeOrmPort } from './typeorm-session';

/**
 * Command line of the schema runner: `<plan|apply|revert> --env=test --target=agenda_test --confirm=<token> [--show-definitions solo en plan]`.
 * Everything that touches the process is injected into runCli, so the whole flow is exercised offline; only main()
 * binds the real process. El resumen usa una proyección cerrada; plan puede añadir definiciones validadas y su digest.
 * Ningún mensaje del driver ni traza llega a stdout. Exit codes: 0 verified success, 2 refused or failed with a verified closure, 3 outcome or closure
 * not verified (ambiguous COMMIT, lock or resources unverified, hard time limit).
 */
export interface CliDeps {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly write: (line: string) => void;
  readonly signals: { on(name: string, fn: () => void): unknown; off(name: string, fn: () => void): unknown };
  readonly clock: () => number;
  readonly timers: Timers;
  /** Last-resort exit used only by the hard time limit. */
  readonly exit: (code: number) => void;
  readonly fs?: CredentialFs;
  /** Test seam; the default is the real TypeORM session. */
  readonly openPort?: (options: PostgresDataSourceOptions, mode: SchemaCommand) => SchemaPort;
}

export const DEFINITIONS_PREFIX = 'AGENDA_SCHEMA_DEFINITIONS ';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
/** Se descarta toda salida del driver y de TypeORM; solo se emiten proyecciones controladas. */
const silentLogger = () => new SafeTypeOrmLogger({ warn: () => undefined, error: () => undefined, debug: () => undefined });

export async function runCli(deps: CliDeps): Promise<number> {
  const started = deps.clock();
  const elapsed = () => Math.max(0, Math.round(deps.clock() - started));
  let finished = false;
  let aborted = false;
  const emit = (result: RunResult) => {
    deps.write(`${SUMMARY_PREFIX}${JSON.stringify(summaryOf(result))}\n`);
    if (result.definitions.length === 0 || result.definitionsOmitted) return;
    for (const line of result.definitions) deps.write(`${DEFINITIONS_PREFIX}${JSON.stringify({ kind: line.kind, table: line.table, name: line.name, definition: line.definition })}\n`);
    deps.write(`${DEFINITIONS_PREFIX}${JSON.stringify({ structureDigest: result.structureDigest, count: result.definitions.length })}\n`);
  };
  const onSignal = () => { aborted = true; };
  for (const name of SIGNALS) deps.signals.on(name, onSignal);
  const hard = deps.timers.set(() => {
    if (finished) return;
    finished = true;
    emit(refusal(null, 'hard_timeout', elapsed(), 3));
    deps.exit(3);
  }, BUDGET.hardExitMs);

  let command: SchemaCommand | null = null;
  try {
    command = authorize(deps.argv);
    const { showDefinitions } = parseArguments(deps.argv);
    const config = loadOwnerConfiguration({ cwd: deps.cwd, fs: deps.fs });
    const options = createSchemaDataSourceOptions(config, command, { logger: silentLogger() });
    const port = deps.openPort ? deps.openPort(options, command) : createTypeOrmPort({ options, mode: command });
    const result = await runSchema({ command, showDefinitions, port, clock: deps.clock, timers: deps.timers, aborted: () => aborted });
    if (!finished) { finished = true; emit(result); }
    return result.exit;
  } catch (error) {
    const code: RunnerCode = error instanceof SchemaRunnerError ? error.code : 'internal_error';
    if (!finished) { finished = true; emit(refusal(command, code, elapsed(), 2)); }
    return 2;
  } finally {
    deps.timers.clear(hard);
    for (const name of SIGNALS) deps.signals.off(name, onSignal);
  }
}

/** Binds the real process. Never invoked by the tests. */
export function main(): void {
  void runCli({
    argv: process.argv.slice(2), cwd: process.cwd(), write: line => { process.stdout.write(line); },
    signals: process, clock: () => performance.now(), exit: code => process.exit(code),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => { clearTimeout(handle as NodeJS.Timeout); } },
  }).then(code => { process.exit(code); });
}

if (require.main === module) main();
