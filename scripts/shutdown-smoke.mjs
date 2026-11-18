// One-off smoke check: proves the SIGINT/SIGTERM shutdown sequence finishes
// even while a client holds an SSE stream open (the closeAllConnections fix).
// Windows cannot deliver real SIGTERM/SIGINT from outside, so the parent here
// runs the exact sequence the signal handler executes, in-process, while a
// child process keeps an SSE connection open from outside. Not in the suite.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { closeDatabase } from '../src/lib/db.js';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'shutdown-smoke-')), 'smoke.db');

const server = createServer();
await new Promise((resolve) => server.listen(3196, '127.0.0.1', resolve));
const port = server.address().port;

// A separate process holds the SSE stream open, like a real browser tab.
const client = spawn(
  process.execPath,
  [
    '-e',
    `fetch('http://127.0.0.1:${port}/api/events?conversationId=cnv_smoketest01').then(async (r) => { console.log('sse', r.status); await new Promise(() => {}) })`
  ],
  { stdio: 'pipe' }
);
let clientOutput = '';
client.stdout.on('data', (d) => { clientOutput += d; });

await new Promise((r) => setTimeout(r, 500)); // let the SSE connect
console.log('client saw:', clientOutput.trim() || '(nothing yet)');

// Mirror the signal handler in start(): close, then destroy the connections.
const closed = new Promise((resolve) => server.close(resolve));
server.closeAllConnections?.();
const won = await Promise.race([
  closed.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 5_000))
]);
console.log(won ? 'close callback fired while SSE open' : 'TIMEOUT waiting for close');
client.kill('SIGKILL');
closeDatabase();
console.log(won ? 'SHUTDOWN-SMOKE: PASS' : 'SHUTDOWN-SMOKE: FAIL');
process.exit(won ? 0 : 1);
