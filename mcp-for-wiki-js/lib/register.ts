import { z } from 'zod';
import type { McpServer, ServerContext, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { allTools, type ToolDef } from './tools/index';
import { resolveContext, basePolicy, toolExtraFromServerContext, type WikiContext } from './context';
import { fail, isDryRun, redactSecrets } from './wikijs/format';
import { oauthEnabled } from './oauth/crypto';
import { GuardrailError } from './guardrails';
import type { Category } from './permissions';

const CATEGORY_LABEL: Record<Category, string> = {
  read: 'read',
  write: 'write',
  delete: 'delete (destructive)',
  manage_users: 'user management',
  manage_groups: 'group / permission management',
  manage_system: 'system administration',
  manage_auth: 'authentication / API keys',
};

/** Reads and read-only manage_* tools (R-56): readOnlyHint, no audit line. */
function isReadOnly(tool: ToolDef): boolean {
  return tool.category === 'read' || tool.readOnly === true;
}

/** Hints derived from the category, overridden by the tool's own `annotations` (R-38). */
function annotationsFor(tool: ToolDef): ToolAnnotations {
  const base: ToolAnnotations = { title: tool.title ?? tool.name, openWorldHint: true };
  let derived: ToolAnnotations = {};
  if (isReadOnly(tool)) derived = { readOnlyHint: true };
  else if (tool.category === 'delete' || tool.category === 'manage_system' || tool.category === 'manage_auth') {
    derived = { destructiveHint: true };
  }
  return { ...base, ...derived, ...tool.annotations };
}

function describe(tool: ToolDef): string {
  return (
    tool.description +
    `\n\nPolicy category: ${CATEGORY_LABEL[tool.category]}.` +
    ' When the active policy sets this to "confirm", a dry-run preview is returned unless you pass confirm=true.'
  );
}

/** The arguments as shown in a dry run: secrets redacted at any depth, file payloads summarised (R-19). */
function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { confirm: _confirm, ...rest } = redactSecrets(args) as Record<string, unknown>;
  if (typeof rest.contentBase64 === 'string') rest.contentBase64 = `<base64, ${rest.contentBase64.length} chars>`;
  return rest;
}

async function confirmPreview(tool: ToolDef, args: Record<string, unknown>, ctx: WikiContext): Promise<CallToolResult> {
  const summary = tool.description.split('\n')[0];
  // A tool can resolve what the call would actually hit (e.g. bulk delete targets, R-06).
  let affected = '';
  if (tool.preview) {
    try {
      affected = `Would affect (resolved now):\n${JSON.stringify(await tool.preview(args, ctx), null, 2)}\n\n`;
    } catch (e) {
      affected = `Would affect: could not be resolved (${e instanceof Error ? e.message : String(e)}).\n\n`;
    }
  }
  const text =
    `⚠️ Confirmation required — '${tool.name}' is gated by policy (category: ${CATEGORY_LABEL[tool.category]}).\n\n` +
    `Action: ${summary}\n\n` +
    `Arguments:\n${JSON.stringify(previewArgs(args), null, 2)}\n\n` +
    affected +
    `This was a DRY RUN — nothing has changed. To execute, call '${tool.name}' again with "confirm": true.`;
  return { content: [{ type: 'text', text }] };
}

/** Structured, secret-free audit line for write/delete/admin actions (goes to the server logs,
 *  and — when the OAuth store is enabled — to the persistent audit_log table). */
function audit(tool: ToolDef, profile: string | undefined, sessionId: string | undefined, outcome: string, ms: number): void {
  if (process.env.WIKIJS_AUDIT === 'false') return;
  console.log(
    JSON.stringify({ audit: 'wikijs-mcp', tool: tool.name, category: tool.category, profile: profile ?? null, outcome, ms }),
  );
  if (oauthEnabled()) {
    // Fire-and-forget: auditing must never fail or slow the tool call — but a
    // lost audit row must be visible to the operator (R-39).
    import('./oauth/store')
      .then((store) =>
        store.insertAudit({
          ts: Date.now(),
          sessionId: sessionId ?? null,
          profile: profile ?? null,
          tool: tool.name,
          category: tool.category,
          outcome,
          ms,
        }),
      )
      .catch((e) => console.error(`Audit log write failed (tool ${tool.name}, outcome ${outcome}):`, e));
  }
}

/**
 * Register all tools on an McpServer, applying the permission policy:
 *  - registration uses the deployment BASELINE policy (env) to hide blocked tools,
 *  - each invocation re-resolves the EFFECTIVE policy (baseline + per-request overlay)
 *    so a request header can only ever tighten access.
 */
export function registerAll(server: McpServer): void {
  const base = basePolicy();

  for (const tool of allTools) {
    const baseMode = base.resolve(tool.name, tool.category);
    if (baseMode === 'block' && !base.showBlocked) continue; // hidden at the deployment level

    // Every tool can be set to "confirm" by a policy — reads included — so every
    // schema carries the field; otherwise zod strips it and the call never runs (R-34).
    const shape: Record<string, z.ZodTypeAny> = {
      ...(tool.inputSchema as Record<string, z.ZodTypeAny>),
      confirm: z.boolean().optional().describe('Set true to execute when this action is gated by a "confirm" policy.'),
    };

    server.registerTool(
      tool.name,
      {
        title: tool.title ?? tool.name,
        description: describe(tool),
        inputSchema: z.object(shape),
        annotations: annotationsFor(tool),
      },
      async (args: Record<string, unknown>, serverCtx: ServerContext): Promise<CallToolResult> => {
        const startedAt = Date.now();
        let profile: string | undefined;
        let sessionId: string | undefined;
        let outcome = 'preview';
        try {
          const ctx = resolveContext(toolExtraFromServerContext(serverCtx));
          profile = ctx.profile;
          sessionId = ctx.sessionId;
          const mode = ctx.policy.resolve(tool.name, tool.category);
          if (mode === 'block') {
            outcome = 'blocked';
            return fail(
              `Tool '${tool.name}' is blocked by the active permission policy (category: ${tool.category}).`,
            );
          }
          if (mode === 'confirm' && (args as { confirm?: boolean }).confirm !== true) {
            outcome = 'preview';
            return await confirmPreview(tool, args ?? {}, ctx);
          }
          const result = await tool.handler(args ?? {}, ctx);
          // A handler's own dry run (parameter gate, raw GraphQL mutation) executed nothing.
          outcome = result.isError ? 'error' : isDryRun(result) ? 'preview' : 'ok';
          return result;
        } catch (e) {
          outcome = e instanceof GuardrailError ? 'blocked' : 'error';
          return fail(e instanceof Error ? e.message : String(e));
        } finally {
          // Audit state-changing actions (executions + blocked attempts); skip reads,
          // read-only manage_* tools (R-56) and dry-run previews.
          if (!isReadOnly(tool) && outcome !== 'preview') {
            audit(tool, profile, sessionId, outcome, Date.now() - startedAt);
          }
        }
      },
    );
  }
}
