# Wiki.js + MCP — a team knowledge base for humans & AI agents

> 🇩🇪 Deutsche Version: [README.md](README.md)

A [Wiki.js](https://js.wiki/) wiki that AI agents (Claude, ChatGPT/Codex,
Cursor, …) can use safely through the **Model Context Protocol**:

- **One secret-free connector URL for everyone** (`https://<domain>/mcp`) — no
  keys, no personal data in the URL.
- **The wiki login is the only login** (OAuth 2.1): connecting a client sends
  you through your normal Wiki.js sign-in — one click if you are already
  logged in. No second user directory to maintain.
- **Per-person permissions, enforced by Wiki.js itself** (groups + page
  rules); the MCP server adds agent safety on top: dry-run **confirm** gates
  before destructive actions and a **tag guardrail** (`kein-ki` / "no-AI")
  that hides pages from agents entirely.
- **Self-service at `/me`**: every user sees and revokes their own AI
  connections; wiki admins additionally see all sessions and the audit log.

```
                   ┌──────────────────────── one host / one domain ────────────────────────┐
  Browser ────────►│  caddy ──► /mcp /oauth /me /.well-known… ──► mcp  ──► GraphQL ──► wiki │
  MCP clients ────►│        ──► everything else ────────────────────────────────────► wiki │
                   │                                          wiki ──► postgres (db)       │
                   └───────────────────────────────────────────────────────────────────────┘
```

## Quick start (Docker Compose)

```bash
cp .env.example .env     # set DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d     # Caddy obtains TLS automatically
```

Local testing without a domain/TLS (everything on `http://localhost:8090`):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

**Wiki.js itself does not live in this repo:** it runs from the official
`requarks/wiki:2` image, pulled automatically on first start. This repo only
contains the MCP server, the deployment configuration and a mounted wiki
config ([deploy/wiki/config.yml](deploy/wiki/config.yml) — unchanged except
for the DB pool). Updating the wiki = pulling a new image.

## First-run setup (admin account, home page, search)

A fresh Wiki.js starts in setup mode. The bootstrap script does everything in
one go — **idempotent**, safe to re-run (Node ≥ 18 on the host):

```bash
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='secure-password' \
  node deploy/scripts/bootstrap.mjs --locale=de
```

This creates: the admin account, a home page, the **PostgreSQL search
engine** (dictionary matching the locale — much better agent search than the
default), and with `--locale=de` the German UI. For a stack on another URL
prefix set `WIKI_URL=https://wiki.example.org`.

`--demo` additionally creates a "Team" group (read/write, no delete) plus a
test user and then **requires `DEMO_PASSWORD`** (no default — a committed one
would ship a publicly-known write-capable account). Test instances only, never
a production wiki.

Tip if a manual browser login won't stick (logged out again after signing
in): an ad/tracking blocker (e.g. Brave Shields) is usually blocking the
site's cookies.

Afterwards, manage users entirely in Wiki.js: Administration → Groups
(a group with `read:pages`, `write:pages`, … — **without** `manage:system`)
→ Users. Details: [concept & permission model](mcp-for-wiki-js/docs/concept-ai-access.en.md).

## Already running Wiki.js? Add only the MCP server

If a Wiki.js 2.x container already exists, add the MCP server next to it —
the wiki stays untouched (no fork, no migration):

```bash
docker build -t wikijs-mcp .
docker run -d --name wikijs-mcp --restart unless-stopped \
  --network <network-of-the-wiki-container> \
  -v mcp-data:/data \
  -e WIKIJS_URL=http://<wiki-container>:3000 \
  -e PUBLIC_BASE_URL=https://wiki.example.org \
  -e MCP_SESSION_SECRET=<32-random-bytes> \
  -e WIKIJS_PERMISSION_PRESET=full \
  -e WIKIJS_BLOCKED_TAGS=kein-ki \
  wikijs-mcp
```

Then route the MCP paths on the **same host** in your existing reverse proxy
(`/mcp`, `/oauth`, `/me`, `/.well-known/oauth-*`,
`/.well-known/mcp.json`, `/_next`, `/api/health` → `wikijs-mcp:3000`,
everything else to the wiki) — template:
[deploy/caddy/Caddyfile](deploy/caddy/Caddyfile). The shared domain matters:
it turns the OAuth consent into one click via the existing wiki session.
Also recommended: raise the wiki DB pool (10 → 20, see
[deploy/wiki/config.yml](deploy/wiki/config.yml)) and enable the PostgreSQL
search engine.

## Repository layout

| Path | Contents |
|---|---|
| [`mcp-for-wiki-js/`](mcp-for-wiki-js/) | The MCP server (Next.js/TypeScript): 70 tools over the Wiki.js GraphQL API, OAuth layer, permission engine, tests. Details: [README (EN)](mcp-for-wiki-js/README.en.md) · [concept & permission model (EN)](mcp-for-wiki-js/docs/concept-ai-access.en.md) |
| [`Dockerfile`](Dockerfile) | Production image of the MCP server (Next.js standalone, Node 24) |
| [`docker-compose.yml`](docker-compose.yml) | Full stack: Postgres + Wiki.js + MCP + Caddy (auto-HTTPS) + daily DB backup |
| [`deploy/caddy/`](deploy/caddy/) | Reverse-proxy routing (one domain for wiki & MCP → one-click SSO) |
| [`deploy/scripts/bootstrap.mjs`](deploy/scripts/bootstrap.mjs) | Idempotent first-run setup |
| [`deploy/helm/wikijs-mcp/`](deploy/helm/wikijs-mcp/) | Helm chart for Kubernetes (MCP server; Wiki.js runs separately) |
| [`.github/workflows/`](.github/workflows/) | GitHub CI: typecheck/tests/build + image → ghcr.io |
| [`.gitlab-ci.yml`](.gitlab-ci.yml) | GitLab CI: same checks + image → company registry + Helm chart push |

Not part of the repo (excluded via `.gitignore`): `wiki/` (reference clone of
requarks/wiki) and `mcp2/` (community MCP servers used for comparison).

## Permissions & safeguards — who enforces what?

| Layer | Maintained in | Effect |
|---|---|---|
| Access rights | **Wiki.js** (groups, page rules — per person) | hard, server-side; applies to AI sessions too |
| Area lock-out | Wiki.js: path-based **deny page rule** (e.g. `/internal/*`) | reliable, including search |
| Tag guardrail | Tag (e.g. `kein-ki`) on the page + `WIKIJS_BLOCKED_TAGS` on the MCP server | MCP hides the page from agents (search/list/read) and refuses writes/moves/deletes |
| Agent brake | MCP role `wiki` (default for OAuth sessions) | destructive/admin actions return a **dry-run preview** first; they execute only when the AI calls again with `confirm: true` — the AI relays the question to you in chat |

**How the confirm prompt works:** the MCP server never talks to the human
directly. A gated tool call without `confirm: true` executes nothing and
returns a dry-run preview ("⚠️ Confirmation required … This was a DRY RUN —
nothing has changed."). The AI shows that in the chat, asks you, and only
then repeats the call with `confirm: true`. It is a two-step brake, not a
hard gate — whether someone *may* delete at all is always decided by
Wiki.js' own permissions.

**Setting up the tag guardrail:** choose the tags via `WIKIJS_BLOCKED_TAGS`
(comma-separated, case-insensitive; appliance default `kein-ki`; empty =
off), then tag pages in the wiki editor: edit page → **page properties** →
**tags** → add `kein-ki` → save. Takes effect immediately (≤ 60 s cache);
agents cannot rename or delete the guardrail tags themselves. Important:
never give AI-facing accounts `manage:system` in Wiki.js — that permission
bypasses all page rules there.

## Kubernetes / GitLab

The [Helm chart](deploy/helm/wikijs-mcp/README.md) deploys only the MCP
server (StatefulSet + small PVC for the session store); Wiki.js runs as its
own deployment and is wired up via `config.wikijs.url`. The GitLab pipeline
builds the image and packages/pushes the chart — the required CI/CD
variables are listed at the top of [.gitlab-ci.yml](.gitlab-ci.yml). Both
pipelines stay green while the registry variables are absent (jobs are
skipped).

## Publishing (GitHub / GitLab)

`mcp-for-wiki-js/` currently carries its **own git history** (embedded
repo). Decide before the first push of this root repo: one repo
(recommended; remove `mcp-for-wiki-js/.git`, then `git init && git add . &&
git commit` at the root — or migrate the history via `git subtree` /
`git filter-repo` first) or two repos with a submodule.

## License

MIT — see [mcp-for-wiki-js/LICENSE](mcp-for-wiki-js/LICENSE).
