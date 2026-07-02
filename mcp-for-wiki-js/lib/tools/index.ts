import type { ToolDef } from './types';
import { pageTools } from './pages';
import { assetTools } from './assets';
import { userTools } from './users';
import { groupTools } from './groups';
import { commentTools } from './comments';
import { navigationTools } from './navigation';
import { systemTools } from './system';

export const allTools: ToolDef[] = [
  ...pageTools,
  ...assetTools,
  ...commentTools,
  ...navigationTools,
  ...userTools,
  ...groupTools,
  ...systemTools,
];

// Fail fast on duplicate tool names (catches copy/paste mistakes at import time).
const seen = new Set<string>();
for (const t of allTools) {
  if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  seen.add(t.name);
}

export type { ToolDef };
