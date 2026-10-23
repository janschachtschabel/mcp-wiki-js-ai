import type { WikiContext } from '../context';

/**
 * The wiki's default locale (Admin → Locale), used when a tool call names no
 * locale (audit A-26). A hard "en" broke path lookups on every non-English wiki.
 * `localization.config` needs no permission. Cached per wiki for a few minutes;
 * a failed lookup falls back to "en" (the former default) and is not cached.
 */

const TTL_MS = 5 * 60_000;
const FALLBACK = 'en';
const cache = new Map<string, { at: number; locale: string }>();

export async function siteLocale(ctx: WikiContext): Promise<string> {
  const hit = cache.get(ctx.baseUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.locale;
  let locale: unknown;
  try {
    const data = await ctx.client.request<{ localization?: { config?: { locale?: string } } }>(
      'query{ localization { config { locale } } }',
    );
    locale = data?.localization?.config?.locale;
  } catch (e) {
    console.warn(`[site-locale] lookup failed, using "${FALLBACK}": ${e instanceof Error ? e.message : String(e)}`);
    return FALLBACK;
  }
  if (typeof locale !== 'string' || !locale) return FALLBACK;
  if (cache.size >= 100) cache.clear(); // BYOK callers can name many wikis: stay bounded
  cache.set(ctx.baseUrl, { at: Date.now(), locale });
  return locale;
}

/** The given locale, or the site locale when the caller named none. */
export async function localeOrSite(ctx: WikiContext, locale: string | undefined): Promise<string> {
  return locale || (await siteLocale(ctx));
}

/** Test hook. */
export function clearSiteLocaleCache(): void {
  cache.clear();
}
