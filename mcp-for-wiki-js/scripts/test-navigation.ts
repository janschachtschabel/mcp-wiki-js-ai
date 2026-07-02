/**
 * Regression test for the navigation destructive-change guard.
 *
 * Background: Wiki.js stores the whole site navigation as a single `key='site'` blob and
 * `updateTree` REPLACES it wholesale (it does not merge per locale). A test that set the
 * `de` tree to empty therefore wiped the entire navigation (incl. the `en` Home link) in
 * production. `navigationLosses()` detects exactly these destructive replacements so the
 * tool can refuse them unless force=true. These assertions lock that behavior in.
 *
 * Run: npm run test:nav   (no network — pure logic).
 */
import { navigationLosses } from '../lib/tools/navigation';

const home = [{ id: 'x', kind: 'link', label: 'Home' }];
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

// The actual incident: current en=[Home]; proposed [{ de: [] }] -> en removed entirely.
check(
  'incident: empty de tree drops en/Home -> destructive',
  navigationLosses([{ locale: 'en', items: home }], [{ locale: 'de', items: [] }]).length === 1,
);
// Whole tree emptied -> destructive.
check('[] wipes everything -> destructive', navigationLosses([{ locale: 'en', items: home }], []).length === 1);
// Clearing an existing locale's items -> destructive.
check(
  'en items cleared -> destructive',
  navigationLosses([{ locale: 'en', items: home }], [{ locale: 'en', items: [] }]).length === 1,
);
// Two locales, one dropped -> destructive (reports the dropped one).
check(
  'drop one of two locales -> destructive',
  navigationLosses(
    [
      { locale: 'en', items: home },
      { locale: 'de', items: home },
    ],
    [{ locale: 'en', items: home }],
  ).length === 1,
);
// Identical tree -> safe.
check(
  'identical tree -> safe',
  navigationLosses([{ locale: 'en', items: home }], [{ locale: 'en', items: home }]).length === 0,
);
// Adding a NEW locale while keeping en -> safe (additive).
check(
  'add de, keep en -> safe',
  navigationLosses(
    [{ locale: 'en', items: home }],
    [
      { locale: 'en', items: home },
      { locale: 'de', items: home },
    ],
  ).length === 0,
);
// Current empty, set empty -> safe (nothing to lose).
check('empty -> empty -> safe', navigationLosses([{ locale: 'en', items: [] }], [{ locale: 'de', items: [] }]).length === 0);

if (failed === 0) {
  console.log(`\n${pass} navigation-guard assertions passed.`);
} else {
  console.error(`\n${failed} navigation-guard assertion(s) FAILED.`);
  process.exit(1);
}
