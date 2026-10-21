# mcp-wikijs-mv

> 🇩🇪 Deutsche Version (ausführlich, inkl. Legacy-Betrieb): [README.md](README.md)

An **MCP server for [Wiki.js](https://js.wiki/)** with three goals:

1. **Near-complete coverage of the GraphQL API** — **70 tools** across all
   domains (pages, tags, assets incl. file upload **and download**, users,
   groups, comments, navigation, auth/API keys, site/system), plus a
   `wiki_graphql` escape hatch for 100 % coverage.
2. **Fine-grained control for agents** — per category/tool: *allow* /
   *confirm* (dry-run first) / *block*, plus a tag guardrail that hides
   pages from AI entirely.
3. **True multi-user operation** — in OAuth mode every session acts as a
   real Wiki.js **user** with that person's own groups and page rules,
   enforced by Wiki.js itself.

Runs in two modes from **one** codebase:

| Mode | Transport | Use | Auth |
|---|---|---|---|
| **HTTP** | Streamable HTTP (`/mcp`) | **Docker/self-hosted** (recommended) or Vercel | **OAuth with the Wiki.js login** (recommended) or per-request headers/URL params (legacy) |
| **stdio** | stdio | local (Claude Desktop, Cursor) | from env |

## OAuth mode ("the wiki login is the login")

Setting `MCP_SESSION_SECRET` enables OAuth 2.1: all clients (claude.ai,
Claude Code, ChatGPT/Codex, Cursor) connect with **one secret-free URL**
(`https://<host>/mcp`). The authorization step is the normal Wiki.js
sign-in — one click when a wiki session already exists on the same domain
(that is why the deployment routes wiki and MCP through one host). Sessions
carry the **user's JWT** (AES-GCM-encrypted at rest, sqlite via
`node:sqlite`, zero extra dependencies); tokens are stored hashed, refresh
tokens rotate with reuse detection, and Wiki.js' rolling `new-jwt` renewal
is captured automatically. Self-service at **`/me`** (view/revoke own
connections; wiki admins see all sessions + the audit log).

Full write-up: [docs/concept-ai-access.en.md](docs/concept-ai-access.en.md)
(concept, permission model, safeguards) · [docs/oauth.md](docs/oauth.md)
(technical deep-dive, German).

## Quick start

```bash
npm install
npm run dev        # HTTP dev server on :3030
npm run stdio      # stdio transport (WIKIJS_URL/WIKIJS_TOKEN from env)
npm test           # 775 offline assertions across 19 suites
npm run typecheck && npm run build
```

Production container + full appliance (Postgres + Wiki.js + MCP + Caddy):
see the repo-root [README.en.md](../README.en.md) and `docker-compose.yml`.

## Agent safeguards

- **Confirm gates:** destructive/admin tools called without `confirm: true`
  return a dry-run preview instead of executing ("⚠️ Confirmation required …
  This was a DRY RUN"). The AI relays that question in the chat and repeats
  the call with `confirm: true` after your go-ahead. A two-step brake, not
  a human approval — the model sets `confirm` itself; hard permissions
  always come from Wiki.js. Every tool accepts `confirm` (reads too); the
  preview redacts passwords/secrets/tokens and shortens `contentBase64`.
- **Tag guardrail:** pages tagged with any `WIKIJS_BLOCKED_TAGS` entry
  (e.g. `kein-ki`) are invisible and untouchable for agents — filtered from
  search/list/read (id- **and** path-based, robust against stale search
  indexes), refused for render/update/move/delete, removed from tree/links,
  and comments are checked for list/create; the guardrail tags themselves
  cannot be renamed/deleted by agents. Limit: `wiki_comment_get`/`_update`/
  `_delete` address a comment by its own id and stay unchecked (Wiki.js
  returns no page id there). Tags are set as normal
  page tags in the wiki editor (page properties → tags).
- **Page scripts:** `scriptJs`/`scriptCss` on page create/update need the
  `manage_system` mode (policy key `wiki_page_scripts`).
- **Audit log:** write/delete/admin actions are logged with the person's
  label (and persisted when OAuth mode is on); read-only `manage_*` tools
  are not logged, policy and tag-guardrail refusals appear as `blocked`.
- **Robustness:** upstream concurrency gate, request timeouts, response size
  cap (`WIKIJS_MAX_RESPONSE_BYTES`, default 16 MiB), retries on connection
  failures (mutations only when the request was certainly not sent), content
  truncation; bulk deletes above 50 pages need `force: true`.

## Environment (excerpt)

| Variable | Purpose |
|---|---|
| `WIKIJS_URL` | Base URL of the Wiki.js instance |
| `MCP_SESSION_SECRET` | Enables OAuth mode (≥ 16 chars — a shorter value aborts startup; sessions encrypted with it) |
| `PUBLIC_BASE_URL` | Public origin (OAuth issuer) — required behind a proxy |
| `WIKIJS_OAUTH_ROLE` | Safety overlay for OAuth sessions (default `wiki`: delete/admin → confirm) |
| `WIKIJS_PERMISSION_PRESET` | Global tool-visibility ceiling — keep `full` in OAuth mode |
| `WIKIJS_BLOCKED_TAGS` | Comma-separated no-AI tags (empty = off) |
| `MCP_DATA_DIR` | sqlite session store location (default `./data`, Docker `/data`) |
| `MCP_ALLOWED_REDIRECT_HOSTS` | Optional comma-separated host names OAuth clients may redirect to (loopback always allowed; unset = any https host) |

Complete reference incl. legacy multi-user handles (`WIKIJS_PROFILES`):
[.env.example](.env.example) and the German [README.md](README.md).

## Tests

```bash
npm test          # 19 offline suites: policy, config, context, oauth + store + routes, gate, client, stdio, …
npm run test:live # all tools against a throwaway wiki (docker-compose.test.yml)
```

CI runs typecheck, the offline suites and the production build — on GitHub for
pushes to main, pull requests and release tags, on GitLab for main/develop. The
OAuth E2E and live tool suites need a running stack and are run locally.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
