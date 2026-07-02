/**
 * Regression test for the upstream concurrency gate (overload protection).
 *
 * Verifies: (1) concurrency never exceeds the cap, (2) all queued work still completes,
 * (3) FIFO order, (4) load-shedding — a queued caller is rejected if no slot frees in time.
 *
 * Run: npm run test:sema   (no network — pure timing logic).
 */
import { Semaphore } from '../lib/wikijs/client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

async function main(): Promise<void> {
  // (1)+(2) cap respected, everything completes
  {
    const sem = new Semaphore(3);
    let cur = 0;
    let peak = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 12 }, (_, i) =>
      sem.run(async () => {
        cur++;
        peak = Math.max(peak, cur);
        await sleep(20);
        order.push(i);
        cur--;
        return i;
      }, 5000),
    );
    const results = await Promise.all(tasks);
    check('peak concurrency never exceeds cap (3)', peak === 3);
    check('all 12 tasks completed', results.length === 12 && new Set(results).size === 12);
    check('in-flight back to 0 after drain', sem.inFlight === 0);
    check('FIFO-ish: first 3 finish before last', order.indexOf(11) > order.indexOf(0));
  }

  // (4) load-shedding: queued caller rejected when no slot frees in time
  {
    const sem = new Semaphore(1);
    // hold the only slot for 200ms
    const holder = sem.run(() => sleep(200), 5000);
    await sleep(10); // ensure holder acquired
    let shed = false;
    try {
      await sem.run(() => sleep(10), 50); // can't get a slot within 50ms -> shed
    } catch (e) {
      shed = e instanceof Error && /busy/i.test(e.message);
    }
    check('queued caller is shed with "busy" when slot not free in time', shed);
    await holder;
    check('slot released after holder finished', sem.inFlight === 0);
    // gate still usable afterwards
    const after = await sem.run(async () => 42, 1000);
    check('gate still works after a shed', after === 42);
  }

  if (failed === 0) {
    console.log(`\n${pass} semaphore assertions passed.`);
  } else {
    console.error(`\n${failed} semaphore assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
