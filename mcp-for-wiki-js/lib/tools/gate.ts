import type { CallToolResult } from '@modelcontextprotocol/server';
import type { WikiContext } from '../context';
import type { Category } from '../permissions';
import { dryRun } from '../wikijs/format';
import { GuardrailError } from '../guardrails';

/**
 * Some parameters carry more power than their tool's category: `groups` on
 * users.create/update is group management (audit R-12), `scriptJs`/`scriptCss`
 * on pages is site-wide script injection (R-18). Such a parameter needs the
 * policy mode of `policyKey`/`category`: block → throws a GuardrailError (audited
 * "blocked"), confirm → dry run (audited as a preview) unless confirm=true.
 * Returns the dry run, or undefined when the call may proceed.
 */
export function parameterGate(
  ctx: WikiContext,
  opts: { policyKey: string; category: Category; what: string; confirm: unknown; dryRun: Record<string, unknown> },
): CallToolResult | undefined {
  const mode = ctx.policy.resolve(opts.policyKey, opts.category);
  if (mode === 'block') {
    throw new GuardrailError(
      `Setting ${opts.what} is blocked by the active permission policy (category: ${opts.category}). Omit ${opts.what}.`,
    );
  }
  if (mode === 'confirm' && opts.confirm !== true) {
    return dryRun(
      { dryRun: true, ...opts.dryRun },
      `⚠️ Confirmation required — setting ${opts.what} is gated by policy (category: ${opts.category}). DRY RUN, nothing changed. Call again with "confirm": true.`,
    );
  }
  return undefined;
}
