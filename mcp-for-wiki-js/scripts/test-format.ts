/**
 * Offline tests for pure helpers in lib/wikijs/format.ts.
 * Focus: exceedsByteLimit — the Content-Length gate that lets an asset
 * download be rejected BEFORE its body is buffered into memory.
 * Run: npm run test:format
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { exceedsByteLimit } from '../lib/wikijs/format';

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

if (failed === 0) {
  console.log(`\n${pass} format assertions passed.`);
} else {
  console.log(`\n${failed} FAILED (of ${pass + failed}).`);
  process.exit(1);
}
