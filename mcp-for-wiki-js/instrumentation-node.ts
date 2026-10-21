/**
 * Refuse to start on invalid operator configuration — see lib/config-check.ts.
 * Exits explicitly: an error thrown from instrumentation is only logged by
 * Next, the server would keep serving with the fail-open config.
 */
import { assertConfig } from './lib/config-check';

try {
  assertConfig();
} catch (e) {
  console.error(`[wikijs-mcp] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
