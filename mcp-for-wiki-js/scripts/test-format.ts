/**
 * Offline tests for pure helpers in lib/wikijs/format.ts.
 * Focus: exceedsByteLimit — the Content-Length gate that lets an asset
 * download be rejected BEFORE its body is buffered into memory — and
 * wildcardMatch, the linear path matcher of the bulk delete (R-06/R-27).
 * Run: npm run test:format
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { exceedsByteLimit, wildcardMatch, wildcardMatcher } from '../lib/wikijs/format';

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

check('over the limit → true', exceedsByteLimit('2000', 1000) === true);
check('exactly at the limit → false', exceedsByteLimit('1000', 1000) === false);
check('under the limit → false', exceedsByteLimit('500', 1000) === false);
check('absent header → false (fall back to post-read cap)', exceedsByteLimit(null, 1000) === false);
check('unparseable header → false', exceedsByteLimit('not-a-number', 1000) === false);
check('Infinity limit never exceeded', exceedsByteLimit('9999999', Infinity) === false);

// ---- R-06 / R-27: path wildcard matcher -------------------------------------
// `*` and `?` stay inside one path segment, `**` crosses "/"; matching is linear
// (no backtracking RegExp), so a hostile pattern cannot stall the server.
const m = wildcardMatch;
check('R-06: "*" matches one segment', m('*', 'home') === true);
check('R-06: "*" does NOT cross "/"', m('*', 'docs/intro') === false);
check('R-06: "drafts/*" matches a direct child', m('drafts/*', 'drafts/a') === true);
check('R-06: "drafts/*" does NOT match a grandchild', m('drafts/*', 'drafts/a/b') === false);
check('R-06: "drafts/**" matches any depth', m('drafts/**', 'drafts/a/b/c') === true && m('drafts/**', 'drafts/a') === true);
check('R-06: "**" matches everything', m('**', 'a/b/c') === true);
check('R-06: "?" is one char, not "/"', m('a?c', 'abc') === true && m('a?c', 'a/c') === false);
check('R-06: regex metacharacters are literal', m('a.b+(c)', 'a.b+(c)') === true && m('a.b', 'axb') === false);
check('R-06: anchored (no partial match)', m('docs', 'docs/intro') === false && m('ocs/*', 'docs/a') === false);
check('R-06: "**/x" matches x below at least one segment, not at the root', m('**/x', 'a/b/x') === true && m('**/x', 'x') === false);
const t0 = Date.now();
const evil = m('*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(3000));
check(`R-27: pathological pattern is matched in linear time (${Date.now() - t0} ms)`, evil === false && Date.now() - t0 < 500);

// Review 2026-10-21 #1: cost must not grow with the PATTERN length (pathPattern
// arrives from the client, up to the body limit). Star runs collapse, and the
// match stops once no path position is reachable any more.
const paths200 = Array.from({ length: 200 }, (_, i) => `docs/section-${i}/some-longer-page-name-${i}`);
for (const [label, longPattern, expectedHits] of [
  ['"a*" x 200 000', 'a*'.repeat(200_000), 0],
  ['"*" x 400 000 (= "**")', '*'.repeat(400_000), 200],
  ['"*?" x 200 000', '*?'.repeat(200_000), 0],
] as const) {
  const t1 = Date.now();
  const matcher = wildcardMatcher(longPattern);
  const hits = paths200.filter(matcher).length;
  const ms = Date.now() - t1;
  check(`#1: ${label} against 200 paths stays fast (${ms} ms)`, ms < 1000 && hits === expectedHits);
}
check('#1: star runs keep their meaning ("***" = "**")', m('a***b', 'a/x/b') === true && m('a**b', 'a/x/b') === true && m('a*b', 'a/x/b') === false);
check('#1: "*" x many still matches a single segment', m('*'.repeat(1000), 'home') === true && m('*'.repeat(1001), 'docs/intro') === true);
check('#1: wildcardMatcher compiles once and agrees with wildcardMatch', ['drafts/a', 'drafts/a/b', 'x'].every((p) => wildcardMatcher('drafts/*')(p) === m('drafts/*', p)));

// Review 2026-10-21 #7: "?" and literals work on code points, not UTF-16 units.
check('#7: "?" matches one astral character', m('?', '😀') === true && m('a?c', 'a😀c') === true);
check('#7: "??" does not match one astral character', m('??', '😀') === false);
check('#7: literal astral characters match', m('docs/😀/*', 'docs/😀/x') === true);

if (failed === 0) {
  console.log(`\n${pass} format assertions passed.`);
} else {
  console.log(`\n${failed} FAILED (of ${pass + failed}).`);
  process.exit(1);
}
