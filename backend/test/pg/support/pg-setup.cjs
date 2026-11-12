const { parsePhase, phaseEnvironment } = require('./phase');
const { guardedQuery } = require('./readonly');
// First setup: invalid phases stop BEFORE pg/typeorm imports and DATABASE_* reads.
const phase = parsePhase(process.env.AGENDA_B2B_PHASE, process.env.NODE_ENV);
const environment = phaseEnvironment(phase, { PGOPTIONS: process.env.PGOPTIONS });
if (environment.PGOPTIONS === undefined) delete process.env.PGOPTIONS;
else process.env.PGOPTIONS = environment.PGOPTIONS;
if (phase === 'readonly') {
  const Client = require('pg/lib/client');
  Client.prototype.query = guardedQuery(Client.prototype.query);
}
