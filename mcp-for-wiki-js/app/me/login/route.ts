import { resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { loginWithCredentials } from '../../../lib/oauth/wiki-login';
import { isSecureRequest, meCookieHeader, meCookieValue, sameOrigin, wikiBaseUrl } from '../../../lib/oauth/web';

export const dynamic = 'force-dynamic';

/** Credentials login for /me (sets the encrypted mcp_me cookie). 2FA accounts
 *  use the wiki itself in the same browser instead — documented on the page. */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });

  const form = new URLSearchParams(await req.text());
  const outcome = await loginWithCredentials(wikiBaseUrl(), form.get('username') ?? '', form.get('password') ?? '');

  if (outcome.kind === 'ok') {
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${issuer}/me`,
        'Set-Cookie': meCookieHeader(meCookieValue(outcome.jwt), isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    });
  }

  const message =
    outcome.kind === 'tfa'
      ? 'Dein Konto nutzt 2FA: Melde dich einmal im Wiki selbst an (gleicher Browser) und öffne /me erneut.'
      : outcome.message;
  const url = new URL(`${issuer}/me`);
  url.searchParams.set('login_error', message.slice(0, 180));
  return new Response(null, { status: 303, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}
