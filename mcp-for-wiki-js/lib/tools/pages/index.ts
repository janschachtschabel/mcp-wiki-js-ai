import type { ToolDef } from '../types';
import { pageReadTools } from './read';
import { pageWriteTools } from './write';
import { pageDeleteTools } from './delete';
import { pageAdminTools } from './admin';

/** All page/tag tools, split by permission category (read/write/delete/admin). */
export const pageTools: ToolDef[] = [
  ...pageReadTools,
  ...pageWriteTools,
  ...pageDeleteTools,
  ...pageAdminTools,
];
