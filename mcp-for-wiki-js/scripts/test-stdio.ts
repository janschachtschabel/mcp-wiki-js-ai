/**
 * End-to-end tests for the stdio entry point (bin/stdio.ts), audit R-37.
 * Spawns the real server and speaks newline-delimited JSON-RPC over stdin/stdout.
 * No network: WIKIJS_URL points at a closed local port, the status tool reports
 * the connection error instead of throwing.  Run: npm run test:stdio
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { spawn } from 'node:child_process';

let pass = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('ok  -', name);
  } else {
    failed++;
    console.log('FAIL-', name);
  }
}

interface Run {
  code: number | null;
  stderr: string;
  messages: Array<{ id?: number; result?: any; error?: unknown }>;
}

/**
 * Start bin/stdio.ts and send `steps` in order: a step's messages are written at
 * once, the next step after the next reply. stdin is closed after the last reply;
 * with no steps it stays open (the server keeps running until it exits by itself).
 */
function runStdio(env: Record<string, string>, steps: object[][], preload: string[] = [], timeoutMs = 20000): Promise<Run> {
  return new Promise((resolve) => {
    const imports = ['tsx', ...preload].flatMap((m) => ['--import', m]);
    // Minimal env: the developer's own WIKIJS_* / MCP_* settings must not leak in.
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      ...env,
    };
    const child = spawn(process.execPath, [...imports, 'bin/stdio.ts'], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const run: Run = { code: null, stderr: '', messages: [] };
    let buf = '';
    let next = 0;
    const send = () => {
      for (const msg of steps[next++] ?? []) child.stdin.write(JSON.stringify(msg) + '\n');
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        run.messages.push(JSON.parse(line));
        if (next < steps.length) send();
        else child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => (run.stderr += d));
    const timer = setTimeout(() => {
      run.stderr += '\n[test] TIMEOUT — killed';
      child.kill();
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      run.code = code;
      resolve(run);
    });
    if (steps.length > 0) send();
  });
}

const BASE_ENV = {
  WIKIJS_URL: 'http://127.0.0.1:9', // discard port — connection refused, no network
  WIKIJS_PERMISSION_PRESET: 'editor',
};

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-stdio', version: '1' } },
};
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const statusCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wiki_connection_status', arguments: {} } };

async function main(): Promise<void> {
  // R-37a: a shared .env with MCP_SESSION_SECRET (and multi-user handles) must not
  // take WIKIJS_TOKEN away from the single local stdio user — stdio never does OAuth.
  const shared = await runStdio(
    {
      ...BASE_ENV,
      WIKIJS_TOKEN: 'local-service-token',
      MCP_SESSION_SECRET: 'x'.repeat(32),
      WIKIJS_PROFILES: JSON.stringify({ handle: { label: 'Alice', token: 'k' } }),
    },
    [[initialize], [initialized, statusCall]],
  );
  const reply = shared.messages.find((m) => m.id === 2);
  const text = reply?.result?.content?.[0]?.text ?? '';
  let status: { hasToken?: boolean } = {};
  try {
    status = JSON.parse(text);
  } catch {
    /* reported below */
  }
  check('R-37a: stdio answers wiki_connection_status', typeof status.hasToken === 'boolean');
  check('R-37a: shared .env (MCP_SESSION_SECRET + profiles) → stdio still uses WIKIJS_TOKEN', status.hasToken === true);
  check('stdio exits cleanly when stdin closes', shared.code === 0 || shared.code === null);

  // R-37b: an uncaught exception is logged and ends the process with a non-zero code
  // (instead of leaving a half-broken server running). The preload throws once the
  // server reports ready, i.e. after bin/stdio.ts installed its handler.
  const thrower =
    'data:text/javascript,' +
    encodeURIComponent(
      `const w = process.stderr.write.bind(process.stderr);
       let fired = false;
       process.stderr.write = (chunk, ...rest) => {
         if (!fired && String(chunk).includes('stdio server ready')) {
           fired = true;
           setImmediate(() => { throw new Error('boom-r37b'); });
         }
         return w(chunk, ...rest);
       };`,
    );
  const crash = await runStdio({ ...BASE_ENV, WIKIJS_TOKEN: 't' }, [], [thrower], 15000);
  check('R-37b: uncaught exception is logged to stderr', /boom-r37b/.test(crash.stderr));
  check('R-37b: uncaught exception → process exits with a non-zero code', crash.code !== null && crash.code !== 0);
  if (failed > 0) console.log('--- stderr (crash run) ---\n' + crash.stderr + '\n--- stderr (shared run) ---\n' + shared.stderr);

  if (failed === 0) {
    console.log(`\n${pass} stdio assertions passed.`);
  } else {
    console.error(`\n${failed} stdio assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
