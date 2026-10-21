/**
 * Next.js startup hook (runs once before the server accepts requests).
 * Node-only work lives in instrumentation-node.ts so the Edge analysis of this
 * file never sees process.exit.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}
