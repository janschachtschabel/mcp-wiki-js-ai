/**
 * Offline tests for deploy/scripts/bootstrap.mjs against a stubbed Wiki.js (local
 * HTTP server, no Docker). Audit 2026-10-23 A-36: the automatic run on every
 * deploy (--if-configured) must not reset what admins changed later — language,
 * search engine, the "Team" group — and must not migrate pages on every run;
 * every Wiki.js result is checked.
 * Run: npm run test:bootstrap
 */
export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface WikiState {
  setup: boolean;
  locale: string;
  engine: string;
  pages: string[];
  groups: { id: number; name: string }[];
  users: string[];
  fail?: string;
  calls: string[];
}

const ok = { succeeded: true, message: '' };
const bad = { succeeded: false, message: 'refused by stub' };

/** A tiny Wiki.js: answers the queries bootstrap.mjs sends and records every mutation. */
function startWiki(state: WikiState): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'GET' && req.url === '/healthz') {
      return state.setup ? send(200, 'text/html', '<html>setup</html>') : send(200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'GET') return send(200, 'text/html', '<html></html>');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/finalize') {
        state.calls.push('finalize');
        state.setup = false;
        return send(200, 'application/json', '{"ok":true}');
      }
      const { query, variables = {} } = JSON.parse(raw) as { query: string; variables: Record<string, any> };
      const result = (name: string) => (state.fail === name ? bad : ok);
      const data = (() => {
        if (query.includes('login(')) return { authentication: { login: { jwt: 'jwt', responseResult: ok } } };
        if (query.includes('pages { list { path } }')) return { pages: { list: state.pages.map((p) => ({ path: p })) } };
        if (query.includes('localization { config')) return { localization: { config: { locale: state.locale } } };
        if (query.includes('searchEngines {')) {
          return { search: { searchEngines: ['db', 'postgres', 'elasticsearch'].map((key) => ({ key, isEnabled: key === state.engine })) } };
        }
        if (query.includes('groups { list')) return { groups: { list: state.groups } };
        if (query.includes('users { search')) return { users: { search: state.users.map((email, i) => ({ id: i + 10, email })) } };
        // mutations
        const name = /\{\s*\w+\s*\{\s*(\w+)/.exec(query.replace(/^mutation(\([^)]*\))?/, ''))?.[1] ?? 'unknown';
        state.calls.push(name);
        switch (name) {
          case 'create':
            if (query.includes('pages {')) {
              state.pages.push(variables.path);
              return { pages: { create: { responseResult: result('pages.create') } } };
            }
            if (query.includes('groups {')) {
              const id = 7;
              state.groups.push({ id, name: variables.name });
              return { groups: { create: { responseResult: result('groups.create'), group: { id } } } };
            }
            state.users.push(variables.email);
            return { users: { create: { responseResult: result('users.create') } } };
          case 'downloadLocale':
            return { localization: { downloadLocale: { responseResult: result('downloadLocale') } } };
          case 'updateLocale':
            if (state.fail !== 'updateLocale') state.locale = variables.locale;
            return { localization: { updateLocale: { responseResult: result('updateLocale') } } };
          case 'migrateToLocale':
            return { pages: { migrateToLocale: { responseResult: result('migrateToLocale'), count: 2 } } };
          case 'updateSearchEngines':
            state.engine = (variables.engines as { key: string; isEnabled: boolean }[]).find((e) => e.isEnabled)?.key ?? state.engine;
            return { search: { updateSearchEngines: { responseResult: result('updateSearchEngines') } } };
          case 'rebuildIndex':
            return { search: { rebuildIndex: { responseResult: result('rebuildIndex') } } };
          case 'update':
            return { groups: { update: { responseResult: result('groups.update') } } };
          default:
            return {};
        }
      })();
      send(200, 'application/json', JSON.stringify({ data }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'scripts', 'bootstrap.mjs');

async function run(state: WikiState, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const wiki = await startWiki(state);
  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT, ...args],
        {
          env: {
            NODE_ENV: 'test',
            PATH: process.env.PATH ?? '',
            WIKI_URL: wiki.url,
            PUBLIC_URL: 'https://wiki.example.org',
            ADMIN_EMAIL: 'admin@example.org',
            ADMIN_PASSWORD: 'Admin-Pass-123',
            ...extraEnv,
          },
          timeout: 30_000,
        },
        (err: Error | null, stdout: string, stderr: string) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
      );
    });
  } finally {
    wiki.close();
  }
}

const settled = (over: Partial<WikiState> = {}): WikiState => ({
  setup: false,
  locale: 'de',
  engine: 'postgres',
  pages: ['home', 'ki-zugang'],
  groups: [{ id: 7, name: 'Team' }],
  users: ['test@team.local'],
  calls: [],
  ...over,
});

async function main(): Promise<void> {
  // 1. Fresh wiki, automatic run: finalize, language, search engine — once.
  const fresh: WikiState = { setup: true, locale: 'en', engine: 'db', pages: [], groups: [], users: [], calls: [] };
  let r = await run(fresh, ['--if-configured', '--locale=de']);
  check(`fresh wiki: automatic run succeeds (exit ${r.code})`, r.code === 0);
  check('fresh wiki: finalize, language switch and page migration happen', ['finalize', 'updateLocale', 'migrateToLocale'].every((c) => fresh.calls.includes(c)) && fresh.locale === 'de');
  check('fresh wiki: PostgreSQL search is enabled and indexed', fresh.engine === 'postgres' && fresh.calls.includes('rebuildIndex'));

  // 2. A-36: the next automatic run on the same, unchanged wiki changes nothing.
  const again = settled();
  r = await run(again, ['--if-configured', '--locale=de']);
  check(`settled wiki: automatic run succeeds (exit ${r.code})`, r.code === 0);
  const changing = ['updateLocale', 'migrateToLocale', 'downloadLocale', 'updateSearchEngines', 'rebuildIndex'];
  check(`A-36: no language/search mutation and no re-index on a re-run (${again.calls.join(',') || 'none'})`, !again.calls.some((c) => changing.includes(c)));

  // 3. A-36: settings an admin changed later survive the automatic run.
  const changed = settled({ locale: 'en', engine: 'elasticsearch' });
  r = await run(changed, ['--if-configured', '--locale=de']);
  check('A-36: an admin-chosen language is kept by the automatic run (no en→de migration)', r.code === 0 && changed.locale === 'en' && !changed.calls.includes('migrateToLocale'));
  check('A-36: an admin-chosen search engine is kept by the automatic run', changed.engine === 'elasticsearch' && !changed.calls.includes('updateSearchEngines'));

  // 4. A manual run still applies what it is told to.
  const manual = settled({ locale: 'en', engine: 'db' });
  r = await run(manual, ['--locale=de']);
  check('manual run: --locale=de switches a wiki that differs', r.code === 0 && manual.locale === 'de' && manual.calls.includes('migrateToLocale'));
  check('manual run: a non-PostgreSQL search engine is switched', manual.engine === 'postgres');
  const manualSame = settled();
  r = await run(manualSame, ['--locale=de']);
  check('manual run: nothing to do when the wiki already matches', r.code === 0 && !manualSame.calls.some((c) => changing.includes(c)));

  // 4b. --reapply (e.g. via BOOTSTRAP_ARGS in a panel without a shell) sets the target state again.
  const reapply = settled({ locale: 'en', engine: 'elasticsearch' });
  r = await run(reapply, ['--if-configured', '--locale=de'], { BOOTSTRAP_ARGS: '--reapply' });
  check('--reapply: the automatic run sets language and search engine again', r.code === 0 && reapply.locale === 'de' && reapply.engine === 'postgres');
  const reapplyDemo = settled();
  r = await run(reapplyDemo, ['--if-configured', '--demo'], { DEMO_PASSWORD: 'Demo-Pass-123', BOOTSTRAP_ARGS: '--reapply' });
  check('--reapply: the "Team" group gets its rights again', r.code === 0 && reapplyDemo.calls.includes('update'));

  // 5. A-36: the demo group's rights are only set when the group is created.
  const demo = settled();
  r = await run(demo, ['--if-configured', '--demo'], { DEMO_PASSWORD: 'Demo-Pass-123' });
  check('A-36: an existing "Team" group keeps its rights on the automatic run', r.code === 0 && !demo.calls.includes('update'));
  const demoNew = settled({ groups: [], users: [] });
  r = await run(demoNew, ['--if-configured', '--demo'], { DEMO_PASSWORD: 'Demo-Pass-123' });
  check('demo: a new "Team" group gets its rights and the demo user', r.code === 0 && ['create', 'update'].every((c) => demoNew.calls.includes(c)) && demoNew.users.includes('test@team.local'));

  // 6. A-36: a refused Wiki.js mutation fails the run instead of being logged as done.
  for (const step of ['updateLocale', 'updateSearchEngines', 'groups.update', 'users.create']) {
    const state =
      step === 'updateLocale' ? settled({ locale: 'en', fail: step })
        : step === 'updateSearchEngines' ? settled({ engine: 'db', fail: step })
          : settled({ groups: [], users: [], fail: step });
    r = await run(state, step.startsWith('update') ? ['--locale=de'] : ['--demo'], { DEMO_PASSWORD: 'Demo-Pass-123' });
    check(`A-36: a refused ${step} fails the run (exit ${r.code})`, r.code !== 0 && /refused by stub/.test(r.out));
  }

  if (failed === 0) {
    console.log(`\n${pass} bootstrap assertions passed.`);
  } else {
    console.error(`\n${failed} bootstrap assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
