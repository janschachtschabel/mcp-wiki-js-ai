import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { allTools, type ToolDef } from './tools/index';
import { resolveContext, basePolicy, type ToolExtra } from './context';
import { fail } from './wikijs/format';
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

function annotationsFor(tool: ToolDef): ToolAnnotations {
  const base: ToolAnnotations = { title: tool.title ?? tool.name };
  if (tool.category === 'read') return { ...base, readOnlyHint: true, openWorldHint: true };
  if (tool.category === 'delete') return { ...base, destructiveHint: true, openWorldHint: true };
  if (tool.category === 'manage_system' || tool.category === 'manage_auth') {
    return { ...base, destructiveHint: true, openWorldHint: true };
  }
  return { ...base, openWorldHint: true };
}

function describe(tool: ToolDef, confirmable: boolean): string {
  const note =
    `\n\nPolicy category: ${CATEGORY_LABEL[tool.category]}.` +
    (confirmable
      ? ' When the active policy sets this to "confirm", a dry-run preview is returned unless you pass confirm=true.'
      : '');
  return tool.description + note;
}

function confirmPreview(tool: ToolDef, args: Record<string, unknown>): CallToolResult {
  const shown = { ...args };
  delete (shown as Record<string, unknown>).confirm;
  const summary = tool.description.split('\n')[0];
  const text =
    `⚠️ Confirmation required — '${tool.name}' is gated by policy (category: ${CATEGORY_LABEL[tool.category]}).\n\n` +
    `Action: ${summary}\n\n` +
    `Arguments:\n${JSON.stringify(shown, null, 2)}\n\n` +
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
  if (process.env.MCP_SESSION_SECRET) {
    // Fire-and-forget: auditing must never fail or slow the tool call.
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
      .catch(() => {});
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

    const confirmable = tool.category !== 'read';
    const shape: Record<string, z.ZodTypeAny> = { ...(tool.inputSchema as Record<string, z.ZodTypeAny>) };
    if (confirmable) {
      shape.confirm = z
        .boolean()
        .optional()
        .describe('Set true to execute when this action is gated by a "confirm" policy.');
    }

    server.registerTool(
      tool.name,
      {
        title: tool.title ?? tool.name,
        description: describe(tool, confirmable),
        inputSchema: shape,
        annotations: annotationsFor(tool),
      },
      async (args: Record<string, unknown>, extra: ToolExtra): Promise<CallToolResult> => {
        const startedAt = Date.now();
        let profile: string | undefined;
        let sessionId: string | undefined;
        let outcome = 'preview';
        try {
          const ctx = resolveContext(extra);
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
            return confirmPreview(tool, args ?? {});
          }
          const result = await tool.handler(args ?? {}, ctx);
          outcome = result.isError ? 'error' : 'ok';
          return result;
        } catch (e) {
          outcome = 'error';
          return fail(e instanceof Error ? e.message : String(e));
        } finally {
          // Audit non-read actions (executions + blocked attempts); skip reads and dry-run previews.
          if (tool.category !== 'read' && outcome !== 'preview') {
            audit(tool, profile, sessionId, outcome, Date.now() - startedAt);
          }
        }
      },
    );
  }
}
