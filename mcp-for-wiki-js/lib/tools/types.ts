import type { ZodRawShape } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { Category } from '../permissions';
import type { WikiContext } from '../context';

/** Declarative definition of one MCP tool. Registration + policy wrapping is central. */
export interface ToolDef {
  /** Unique tool name exposed to the client. */
  name: string;
  /** Optional human title (defaults to name). */
  title?: string;
  /** First line is reused in confirm previews — keep it a clear summary. */
  description: string;
  /** Permission category used by the policy engine. */
  category: Category;
  /** Zod raw shape (object of zod types) for the tool input. */
  inputSchema: ZodRawShape;
  /** Optional MCP behavioural hints (merged over the defaults derived from category). */
  annotations?: ToolAnnotations;
  /**
   * Read-only tool in a manage_* category (e.g. listing users): advertised with
   * readOnlyHint and not audited, like the read category. Its policy mode is
   * still that of its category (audit R-56).
   */
  readOnly?: boolean;
  /**
   * Optional: resolve what the call WOULD affect (e.g. the pages a bulk delete
   * hits) for the confirm dry-run. Must not change state (audit R-06).
   */
  preview?: (args: any, ctx: WikiContext) => Promise<unknown>;
  /** Executes the tool. `args` is already validated against inputSchema. */
  handler: (args: any, ctx: WikiContext) => Promise<CallToolResult>;
}

export const DEFAULT_RESPONSE = 'responseResult { succeeded errorCode slug message }';
