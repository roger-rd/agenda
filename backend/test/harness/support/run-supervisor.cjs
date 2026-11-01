'use strict';
const { supervise } = require('../../../scripts/harness/supervisor.cjs');
/** @param {NodeJS.WriteStream} stream */
const sink = stream => ({
  /** @param {Buffer} buffer */
  emit: buffer => stream.write(buffer),
  drain: () => new Promise(resolve => stream.once('drain', resolve)),
});
const code = "process.on('SIGTERM',()=>{});process.stdout.write('CHILD_PID='+process.pid+'\\n');setInterval(()=>{},1000);";
void supervise({ argv: ['-e', code], env: {}, cwd: process.cwd(), secrets: ['SYN-Supervisor42'],
  sinks: { out: sink(process.stdout), err: sink(process.stderr) }, graceMs: 100, postKillWaitMs: 1000, watchdogMs: 5000,
}).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode; });
