# AI access to the team wiki — concept, workflow, permission model

> 🇩🇪 Deutsche Version: [konzept-ki-zugang.md](konzept-ki-zugang.md)

Status: July 2026. This document describes how humans and AI agents (Claude,
ChatGPT/Codex, Cursor, …) work safely on the same Wiki.js, what was rebuilt
on the MCP server, and **who controls which permissions**. Technical
OAuth deep-dive (German): [oauth.md](oauth.md).

---

## 1. Target picture

- **One secret-free connector URL for everyone:** `https://<domain>/mcp`.
  No API keys, no handles, no personal data in the URL — it may be published
  openly in the wiki.
- **The wiki login is the only login.** There is no second user directory:
  whoever exists in the wiki can authorize AI access — with exactly their
  wiki permissions.
- **Operated as a Docker appliance** (Postgres + Wiki.js + MCP server +
  Caddy on one domain). Legacy handle/BYOK access remains functional as a
  fallback.

---

## 2. Workflow for users (setup & daily use)

### Once per AI program (~30 seconds)

1. Enter the connector URL in the client:
   - **Claude Code:** `claude mcp add --transport http wiki https://<domain>/mcp`,
     then `/mcp` → *Authenticate*
   - **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom
     connector* → paste the URL
   - **ChatGPT / Codex:** create a connector with the URL — the OAuth login
     starts automatically
2. The client opens **one browser window** with the consent page:
   - Already signed in to the wiki (same domain) → **one click** "Allow access".
   - Otherwise: enter your wiki credentials **on that page** (incl. a 2FA
     step if enabled). **Never** enter credentials in the LLM/chat itself —
     the LLM program never sees passwords, it only receives an access token.

### Afterwards: working without the wiki open

The wiki does **not** need to be open while you work. The client holds a
token and refreshes it silently; the stored wiki JWT renews itself on every
use. Only after **14 days without use** (Wiki.js' renewal window) or after a
revocation does the client ask for consent again — one browser moment.

### Self-service: `/me`

At `https://<domain>/me` every person sees **their own** AI connections
(client, connected since, last used) and can **revoke them instantly**.
Wiki admins (permission probe against Wiki.js, no group-name guessing)
additionally see **all** active sessions with foreign revoke and the audit
log of recent write/delete/admin actions.

---

## 3. Workflow for admins (operations & user management)

### Users & permissions — exclusively in Wiki.js

There is **no MCP-side user management**. Everything happens in the normal
Wiki.js administration:

1. **Create group(s)** (Administration → Groups), e.g. "Team" with
   `read:pages`, `write:pages`, `read:assets`, `write:assets`,
   `read:comments`, `write:comments`, `read:source`, `read:history`
   (+ a page rule "Allow, START, empty path" with the same roles).
   Deliberately omit `delete:pages` and everything `manage:*`.
2. **Create users** (Administration → Users) and assign the group.
3. Done — the person can sign in to the wiki **and** authorize AI access
   immediately. No redeploy, no env change, no handle generation.

> ⚠️ Never give AI-facing accounts/groups `manage:system` — in Wiki.js that
> permission bypasses **all** page rules.

### Blocking areas from AI

| Method | Where | Effect |
|---|---|---|
| **Path lock** (hard guarantee) | Wiki.js: group → page rule `Deny`, match `START`, path e.g. `internal` | Enforced server-side everywhere, incl. search — for all access of that group |
| **Tag guardrail** (editorial convenience) | Tag (e.g. `kein-ki`) on the page + `WIKIJS_BLOCKED_TAGS` on the MCP server | MCP hides the page from agents (search/list/read) and refuses update/move/delete — for **all** credential types |

Recommendation: keep sensitive content under a locked path; use the tag on
top for ad-hoc cases.

**Tag guardrail step by step:**

1. **Which tags count** is your choice: environment variable
   `WIKIJS_BLOCKED_TAGS` on the MCP server (`.env` of the appliance or
   `config.policy.blockedTags` in the Helm chart). Comma-separated,
   case-insensitive, e.g. `WIKIJS_BLOCKED_TAGS=kein-ki,confidential`.
   Appliance default: `kein-ki`. Apply changes with
   `docker compose up -d mcp`. Empty = feature off.
2. **Tag the content** (anyone with write access, no admin needed): edit the
   page → open **page properties** in the editor → **tags** field → add
   `kein-ki` → save. These are ordinary Wiki.js page tags — the same ones
   that appear in the tag browser (`/t`).
3. **Effect is immediate** (≤ 60 s cache): the page disappears from search
   and listings for all AI access; read/update/move/delete are refused —
   and no agent can rename or delete the guardrail tags themselves. Humans
   in the wiki see the page unchanged.

### Deployment (short version)

```bash
cp .env.example .env    # DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d    # Caddy obtains TLS automatically

# First-run setup (admin account, home page, Postgres search, optional de + demo):
ADMIN_EMAIL=... ADMIN_PASSWORD=... node deploy/scripts/bootstrap.mjs --locale=de
```

DB note: the Wiki.js connection pool is raised to **20** (mounted
`deploy/wiki/config.yml`, `WIKIJS_DB_POOL_MAX`); the MCP server limits
itself to 12 parallel upstream requests. A single wiki instance needs **no
PgBouncer**. Load probe: 30 parallel users × 45 requests → 0 errors, pool
peak = 20. Per instance, enable the **PostgreSQL search engine** (dictionary
matching the language) and rebuild the index after locale migrations.

---

## 4. Secure user identification (no credentials in the LLM)

Only the URL is entered in the LLM program. Identity is established in the
consent moment and carried by tokens afterwards:

1. Client without credentials → server answers `401` + "authorize over
   there" (OAuth discovery). The client rolls a one-time secret (PKCE).
2. **The person** authenticates in the browser against the wiki (session or
   login form). The MCP server binds a session to their wiki identity.
3. The client redeems the consent code — only it can (PKCE proof).
4. From then on every request carries a random 256-bit token
   (`Authorization: Bearer mcp_at_…`). The server maps it to the session and
   talks to Wiki.js with **that person's user JWT**.

Safety layers: tokens stored only as SHA-256 hashes; wiki JWTs
AES-256-GCM-encrypted; access tokens live 1 h with rotating refresh;
**reuse detection** (a replayed rotated refresh token revokes the whole
session); `/me` revocation acts instantly; audit log with real person
labels.

**Office networks / shared IP:** unproblematic. Identity never depends on
the source IP; TLS prevents snooping on the LAN; the OAuth callback runs on
the employee's own `localhost` (no inbound ports). The only shared-bucket
effect: Wiki.js limits password logins to 5/minute per source IP — it only
affects the **login form** during the rare consent moment (the one-click SSO
path never calls the password login).

---

## 5. MCP server rebuild (July 2026)

**New:**

| Building block | Files | Purpose |
|---|---|---|
| OAuth 2.1 layer | `lib/oauth/` (crypto, store, service, wiki-login, metadata, web) | Authorization code + PKCE, dynamic client registration, token/refresh management, Wiki.js credential exchange |
| OAuth endpoints | `app/oauth/*`, `app/.well-known/oauth-*` | Consent page (SSO/login/2FA), token, DCR, discovery (RFC 8414/9728) |
| Session store | sqlite via `node:sqlite` under `MCP_DATA_DIR` | **zero new npm dependencies**; hashed tokens, encrypted JWTs; audit table |
| `/me` page | `app/me/*` | View/revoke own connections; admin section (all sessions + audit) |
| Tag guardrail | `lib/guardrails.ts` + hooks in `lib/tools/pages/` | `WIKIJS_BLOCKED_TAGS`: pages invisible/untouchable for agents; closes Wiki.js' tag-rule gap; guardrail tags protected from rename/delete |
| Role `wiki` | `config/roles.json`, `WIKIJS_OAUTH_ROLE` | Agent-safety overlay for OAuth sessions (see §6) |
| JWT renewal | `lib/wikijs/client.ts` (`new-jwt` header) | Wiki.js' rolling token renewal is persisted → sessions stay fresh without re-login |
| Packaging | Root `Dockerfile` (Next standalone, Node 24), `docker-compose.yml` (db/wiki/mcp/caddy/backup), `deploy/helm/wikijs-mcp`, CI for GitHub (ghcr) + GitLab (registry + Helm) | Single-host appliance; MCP↔wiki over the internal network |

**Hardened after a security review:** guardrail tags cannot be
renamed/deleted by agents; blocked-page cache partitioned per credential;
`mcp_at_*` tokens routed correctly even in mixed configurations;
refresh-token reuse detection; internal URLs removed from browser-facing
error messages. **Follow-up round:** admin view + audit view on `/me`,
`wiki_asset_download` (tool #70, incl. the Wiki.js page-extension caveat),
session auto-cleanup, search guardrail robust against stale search indexes,
daily `pg_dump` backup sidecar.

**Unchanged (backwards compatibility):** stdio mode, BYOK headers,
`WIKIJS_PROFILES` handles incl. the role ladder. These legacy paths are
**frozen** — not needed in OAuth container operation.

**Verification:** 108 offline assertions (6 suites), 33 E2E assertions
against the real stack through a public URL (OAuth → tool call as the real
user → guardrails → revocation), load test 1350 requests / 0 errors.

---

## 6. Permission model: who controls what?

**Short answer: yes — in OAuth mode, user and access control live
exclusively in Wiki.js.** The MCP server manages no users, groups or access
rights; it only adds safeguards that Wiki.js cannot provide:

| Question | Owner | Mechanism |
|---|---|---|
| Who exists? Who belongs to which group? | **Wiki.js** | Users/groups in the admin UI |
| What may a person read/write/delete? | **Wiki.js** | Group permissions + page rules — enforced server-side, for AI sessions too |
| Which areas are off-limits (for humans too)? | **Wiki.js** | `deny` page rules (path-based = hard guarantee) |
| Authentication (password, 2FA) | **Wiki.js** | `login` mutation, its own rate limits |
| Destructive actions only after confirmation | **MCP server** | `confirm` gates of the `wiki` role: `delete` and `manage_*` return a dry-run preview first; execution only with `confirm: true` |
| Hiding specific pages from AI (tag) | **MCP server** | `WIKIJS_BLOCKED_TAGS` (e.g. `kein-ki`) — incl. write refusal and tag self-protection |
| Session lifecycle & revocation | **MCP server** | Token issuance/rotation, 14-day idle expiry, `/me` |
| Accountability | **MCP server** + Wiki.js | Audit log (tool, person, outcome) + wiki page history with real names |
| Overload protection towards the wiki | **MCP server** | Concurrency gate (`WIKIJS_MAX_CONCURRENCY`) |

**How the confirmation prompt actually works:** the MCP server never talks
to the human directly. When the AI calls a gated tool without
`confirm: true`, the server executes **nothing** and returns a dry-run
preview to the AI:

```
⚠️ Confirmation required — 'wiki_page_delete' is gated by policy.
Action: Permanently delete a single page …
Arguments: { "path": "team/testseite-jan", … }
This was a DRY RUN — nothing has changed. To execute, call again with "confirm": true.
```

The AI shows this preview in the chat and asks ("really delete?"); only
after your go-ahead does it call the tool again with `confirm: true`.
Honest framing: this is a **two-step brake**, not a hard gate — a misbehaving
AI could make the second call unasked. Whether someone *may* delete is
therefore always decided by Wiki.js (group permissions); on top of that,
many clients (e.g. Claude Code) ask for their own per-tool approval anyway.
Configurable via `WIKIJS_OAUTH_ROLE`; the global ceiling
`WIKIJS_PERMISSION_PRESET=full` stays open in OAuth mode because the real
limits come from Wiki.js.

The old MCP role ladder (`leser`/`autor`/`redakteur`/… in
`config/roles.json`) has **no function in OAuth mode** — it only applies to
legacy handle access (`WIKIJS_PROFILES`).

---

## 7. Limits & known points

- One-click SSO requires the **same domain** for wiki and MCP (the appliance
  does this automatically); otherwise the login form appears.
- `tree`/`links`, comment tools and `wiki_graphql` are exempt from the
  **tag** guardrail (use path rules for hard blocking); `wiki_graphql` is
  confirm-gated for OAuth sessions.
- Do not create wiki pages under `me/`, `oauth/`, `mcp`, `sse`, `api/` —
  those paths belong to the MCP server (reverse-proxy routing).
- Wiki.js cannot serve assets whose extension is a page extension
  (default `.md/.html/.txt`) — `wiki_asset_download` explains this case.
- `PUBLIC_BASE_URL` is **mandatory** behind a reverse proxy (OAuth issuer,
  redirects, CSRF origin reference).
- claude.ai/ChatGPT (web) cannot reach `localhost` — test web clients only
  after deploying to a public domain.
