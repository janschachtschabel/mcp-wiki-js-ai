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

![Architecture: AI clients and browser → Caddy (one domain) → MCP server (OAuth, policy gate, tools, GraphQL client) → Wiki.js → PostgreSQL on an internal network](mcp-for-wiki-js/docs/architektur.png)

Interactive version with per-component source links (German labels): [docs/architektur.html](mcp-for-wiki-js/docs/architektur.html)
(open locally in a browser; editable archify source: [architektur.archify.json](mcp-for-wiki-js/docs/architektur.archify.json)).

> **For IT:** compact guide covering all paths (existing wiki via Helm/Kubernetes, existing wiki on a
> server with Docker, or fresh install via Docker Compose, plus end-user usage; German):
> [installation-it.md](mcp-for-wiki-js/docs/installation-it.md).
>
> **Without a repo checkout** (compose import by URL in Docker panels, vServers): self-contained files in
> [`deploy/standalone/`](deploy/standalone/) — `docker-compose.full.yml` (full stack, first-run setup runs
> automatically) and `docker-compose.mcp-only.yml` (MCP only, next to an existing wiki). The repo's
> `docker-compose.yml` builds locally and mounts files from `deploy/`; panels then report "not found".

## Quick start (Docker Compose)

```bash
cp .env.example .env     # set DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d     # Caddy obtains TLS automatically
```

Without `DOMAIN` (or `MCP_SESSION_SECRET`), `docker compose` stops with a clear
message ("DOMAIN fehlt — bitte .env anlegen").

Local testing without a domain/TLS (everything on `http://localhost:8090`):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

**Wiki.js itself does not live in this repo:** it runs from the official
`requarks/wiki:2` image, pulled automatically on first start. This repo only
contains the MCP server, the deployment configuration and a mounted wiki
config ([deploy/wiki/config.yml](deploy/wiki/config.yml) — unchanged except
for the DB pool). Updating the wiki = pulling a new image.

### Without a repo checkout: Docker panel / compose by URL

For panels that import a compose file by URL (or a server without `git clone`), do **not** use the
`docker-compose.yml` above (it builds locally and needs repo files; panels then report "not found").
Use this file instead:

```
https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/docker-compose.full.yml
```

Variables in the panel (or in a `.env` next to the file):

| Variable | Value |
|---|---|
| `DOMAIN` | hostname only, e.g. `wiki.example.org` (no `https://`) |
| `POSTGRES_PASSWORD` | random, e.g. `openssl rand -base64 24` |
| `MCP_SESSION_SECRET` | random, at least 16 characters, e.g. `openssl rand -base64 32` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin account; remove `ADMIN_PASSWORD` after the first start |
| `BOOTSTRAP_ARGS` | optional, default `--locale=de` |

Prerequisites: the domain's DNS A record points to the server, ports 80/443 are free. First-run setup
runs automatically on start (log of the `bootstrap` container). Afterwards create a "Team" group in
Wiki.js without `manage:system`; users connect with `https://<DOMAIN>/mcp`. If Wiki.js already runs on
the server, use [`deploy/standalone/docker-compose.mcp-only.yml`](deploy/standalone/docker-compose.mcp-only.yml)
plus proxy rules instead ([IT guide, option B](mcp-for-wiki-js/docs/installation-it.md#option-b-bestehendes-wikijs-auf-einem-server-mit-docker-vserver), German).

## First-run setup (admin account, home page, search)

A fresh Wiki.js starts in setup mode. The Compose service `bootstrap` does
everything in one go — **idempotent**, safe to re-run (no Node on the host):

```bash
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='secure-password' \
  docker compose run --rm bootstrap --locale=de
# local test stack: same -f flags as for `up`
#   docker compose -f docker-compose.yml -f docker-compose.local.yml run --rm bootstrap --locale=de
```

**Why not in the browser?** Until setup is done, the first call to Wiki.js'
`/finalize` creates the admin account — for anyone who can reach the domain.
Caddy therefore always answers `/finalize` with `403`; the `bootstrap` service
talks to Wiki.js directly inside the Docker network. The URL shown on
`/ki-zugang` comes from `PUBLIC_BASE_URL` or `https://<DOMAIN>` (locally
`http://localhost:8090`).

This creates: the admin account, a home page, the user guide **`/ki-zugang`**
(connector URL + per-client setup), the **PostgreSQL search
engine** (dictionary matching the locale — much better agent search than the
default), and with `--locale=de` the German UI.

The script can also run directly with Node ≥ 18
(`WIKI_URL=https://wiki.example.org … node deploy/scripts/bootstrap.mjs`; `PUBLIC_URL`
sets a different connector URL for `/ki-zugang`, default `WIKI_URL`) — but
through the domain only for an **already set-up** wiki (e.g. to add `--locale`
or `--demo` later), since `/finalize` is blocked there.

`--demo` additionally creates a "Team" group (read/write, no delete) plus a
test user and then **requires `DEMO_PASSWORD`** (no default — a committed one
would ship a publicly-known write-capable account). Optional: `DEMO_EMAIL`
(default `test@team.local`) and `DEMO_NAME` (default `Test-Zugang`). Test
instances only, never a production wiki.

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
[deploy/caddy/Caddyfile](deploy/caddy/Caddyfile); ready-made compose file
[`deploy/standalone/docker-compose.mcp-only.yml`](deploy/standalone/docker-compose.mcp-only.yml) and tested
nginx/Caddy snippets: [IT guide, option B](mcp-for-wiki-js/docs/installation-it.md#option-b-bestehendes-wikijs-auf-einem-server-mit-docker-vserver). The shared domain matters:
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
| [`deploy/standalone/`](deploy/standalone/) | Self-contained compose files, no repo checkout needed: full stack, or MCP only next to an existing wiki |
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
| Tag guardrail | Tag (e.g. `kein-ki`) on the page + `WIKIJS_BLOCKED_TAGS` on the MCP server | MCP hides the page from agents (search/list/tree/links/read) and refuses writes/moves/deletes; exception: comments addressed only by their comment id |
| Agent brake | MCP role `wiki` (default for OAuth sessions) | destructive/admin actions return a **dry-run preview** first; they execute only when the AI calls again with `confirm: true` — the AI relays the question to you in chat, but it sets `confirm` itself: a brake, **not** a human approval |

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

## Repository & publishing

The project is **one** repo on GitHub:
[github.com/janschachtschabel/mcp-wiki-js-ai](https://github.com/janschachtschabel/mcp-wiki-js-ai).
`mcp-for-wiki-js/` is a plain folder in it (no history of its own, no submodule).
[.gitignore](.gitignore) excludes secrets (`.env`), `node_modules/`, build
output and the reference folders (`wiki/`, `mcp2/`); [.gitattributes](.gitattributes)
normalizes line endings to LF. Before every commit, `git status` must **not** list a `.env`.

A push to `main` builds the image `ghcr.io/janschachtschabel/mcp-wiki-js-ai` via
[.github/workflows/](.github/workflows/). For an internal GitLab, mirror the same
repo: [.gitlab-ci.yml](.gitlab-ci.yml) builds image and Helm chart once the CI/CD
variables listed at its top are set.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
