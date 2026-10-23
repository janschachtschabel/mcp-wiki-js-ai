import type { WikiContext } from '../context';

/**
 * Wiki.js permissions that make an account — or an API key of its group — an
 * administrator: of users, groups, keys or the site, or able to run code in every
 * visitor's browser (theme head/body, page scripts and styles).
 */
const ADMIN_PERMISSION = /^(manage:(system|users|groups|api|theme)|write:(users|groups|scripts|styles))$/;

export function isAdminPermission(permission: string): boolean {
  return ADMIN_PERMISSION.test(permission);
}

/**
 * Whether a group is privileged: the Administrators group (id 1) or any group with an
 * admin-level permission. Fails closed — an unknown or unreadable group counts as
 * privileged.
 */
export async function groupIsPrivileged(ctx: WikiContext, id: number): Promise<boolean> {
  if (id === 1) return true;
  try {
    const data = await ctx.client.request<{ groups: { single: { permissions: string[] } | null } }>(
      `query($id:Int!){ groups { single(id:$id){ permissions } } }`,
      { id },
    );
    const group = data.groups.single;
    return !group || group.permissions.some(isAdminPermission);
  } catch {
    return true; // cannot verify: treat as privileged
  }
}
