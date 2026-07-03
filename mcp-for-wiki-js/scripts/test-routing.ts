/**
 * Offline tests for the /mcp transport routing decision (lib/oauth/routing.ts).
 * The regression that matters: with OAuth enabled, a credential-less request
 * must take the OAuth path even when a single-tenant env token is configured —
 * it must NOT silently fall back to the env key.  Run: npm run test:routing
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { shouldUseOAuth } from '../lib/oauth/routing';

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

const h = (init?: Record<string, string>) => new Headers(init);

// --- OAuth enabled --------------------------------------------------------
// THE fix: no credential → OAuth path, regardless of any env WIKIJS_TOKEN
// (which this predicate deliberately never reads).
check('oauth on, no credential → OAuth path', shouldUseOAuth(true, h()) === true);
check('oauth on, our access token → OAuth path', shouldUseOAuth(true, h({ authorization: 'Bearer mcp_at_abc' })) === true);
check(
  'oauth on, explicit BYOK bearer → legacy path',
  shouldUseOAuth(true, h({ authorization: 'Bearer wikijs-real-api-key' })) === false,
);
check(
  'oauth on, explicit X-Wikijs-Token handle → legacy path',
  shouldUseOAuth(true, h({ 'x-wikijs-token': 'wzp_secret_handle' })) === false,
);
check(
  'oauth on, handle wins even next to a non-mcp bearer',
  shouldUseOAuth(true, h({ 'x-wikijs-token': 'wzp_x', authorization: 'Bearer other' })) === false,
);

// --- OAuth disabled -> always legacy (single-tenant / stdio / BYOK) --------
check('oauth off, no credential → legacy path', shouldUseOAuth(false, h()) === false);
check('oauth off, our-token-shaped bearer → legacy path', shouldUseOAuth(false, h({ authorization: 'Bearer mcp_at_x' })) === false);

if (failed === 0) {
  console.log(`\n${pass} routing assertions passed.`);
} else {
  console.log(`\n${failed} FAILED (of ${pass + failed}).`);
  process.exit(1);
}
