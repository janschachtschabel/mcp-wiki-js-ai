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
npm test           # 108 offline assertions across 6 suites
npm run typecheck && npm run build
```

Production container + full appliance (Postgres + Wiki.js + MCP + Caddy):
see the repo-root [README.en.md](../README.en.md) and `docker-compose.yml`.

## Agent safeguards

- **Confirm gates:** destructive/admin tools called without `confirm: true`
  return a dry-run preview instead of executing ("⚠️ Confirmation required …
  This was a DRY RUN"). The AI relays that question in the chat and repeats
  the call with `confirm: true` after your go-ahead. A two-step brake —
  hard permissions always come from Wiki.js itself.
- **Tag guardrail:** pages tagged with any `WIKIJS_BLOCKED_TAGS` entry
  (e.g. `kein-ki`) are invisible and untouchable for agents — filtered from
  search/list/read (id- **and** path-based, robust against stale search
  indexes), refused for update/move/delete, and the guardrail tags
  themselves cannot be renamed/deleted by agents. Tags are set as normal
  page tags in the wiki editor (page properties → tags).
- **Audit log:** write/delete/admin actions are logged with the person's
  label (and persisted when OAuth mode is on).
- **Robustness:** upstream concurrency gate, request timeouts,
  connection-only retries, content truncation.

## Environment (excerpt)

| Variable | Purpose |
|---|---|
| `WIKIJS_URL` | Base URL of the Wiki.js instance |
| `MCP_SESSION_SECRET` | Enables OAuth mode (≥ 16 chars; sessions encrypted with it) |
| `PUBLIC_BASE_URL` | Public origin (OAuth issuer) — required behind a proxy |
| `WIKIJS_OAUTH_ROLE` | Safety overlay for OAuth sessions (default `wiki`: delete/admin → confirm) |
| `WIKIJS_PERMISSION_PRESET` | Global tool-visibility ceiling — keep `full` in OAuth mode |
| `WIKIJS_BLOCKED_TAGS` | Comma-separated no-AI tags (empty = off) |
| `MCP_DATA_DIR` | sqlite session store location (default `./data`, Docker `/data`) |

Complete reference incl. legacy multi-user handles (`WIKIJS_PROFILES`):
[.env.example](.env.example) and the German [README.md](README.md).

## Tests

```bash
npm test          # policy, navigation guard, semaphore, context, oauth, guardrails
npm run test:live # all tools against a throwaway wiki (docker-compose.test.yml)
```

CI (GitHub + GitLab) runs typecheck, the offline suites and the production
build on every push.

## License

MIT
