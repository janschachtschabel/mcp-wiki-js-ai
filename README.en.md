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

## Quick start: which compose file?

| Situation | File | HTTPS via |
|---|---|---|
| Docker panel importing from GitHub (e.g. Hostinger Docker Manager), Traefik already running | [`docker-compose.yml`](docker-compose.yml) (repo root) | existing Traefik |
| Own server without a reverse proxy, no repo checkout | [`deploy/standalone/full/docker-compose.yml`](deploy/standalone/full/docker-compose.yml) | own Caddy (ports 80/443) |
| Wiki.js already running, add only the MCP server | [`deploy/standalone/mcp-only/docker-compose.yml`](deploy/standalone/mcp-only/docker-compose.yml) | existing proxy |
| Build the image yourself / development (repo checkout) | [`docker-compose.build.yml`](docker-compose.build.yml) | own Caddy (ports 80/443) |

The first two use the published image from GHCR, need **no required variables** and generate the
Postgres password and `MCP_SESSION_SECRET` on first start (volume `stack-secrets` — include it in
backups). First-run setup (admin account, home page, `/ki-zugang`, search, language) runs there
automatically once `DOMAIN`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set.

### Docker panel with Traefik (e.g. Hostinger Docker Manager)

Such panels read only the `docker-compose.yml` in the repo root and copy `.env.example` to `.env`.
Variables can only be edited once the project exists — hence two steps:

1. **Compose from URL** with `https://github.com/janschachtschabel/mcp-wiki-js-ai`, deploy without
   variables.
2. Edit the project, set these in `.env`, redeploy:

| Variable | Value |
|---|---|
| `DOMAIN` | hostname only, e.g. `wiki.example.org` (DNS A record points to the server) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin account; clear `ADMIN_PASSWORD` after setup |
| `BOOTSTRAP_ARGS` | optional, e.g. `--locale=en` (German is the default) or `--demo` |

Traefik routes the MCP paths to the MCP server and everything else to Wiki.js, and blocks the setup
endpoint `/finalize`. The file needs no pre-existing Docker network: it creates its own network
`wikijs-web`, which a Traefik in host mode (as on Hostinger) reaches directly. Entrypoint `websecure`
and certificate resolver `letsencrypt` match Hostinger's Traefik; for another Traefik set
`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER` and — if Traefik runs in its own Docker network —
`TRAEFIK_NETWORK` (that network's name). Setup result: log of the `bootstrap`
container. Then create a "Team" group in Wiki.js without `manage:system`; users connect with
`https://<DOMAIN>/mcp`.

### Own server without a proxy (one file, no repo)

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```

Ports 80/443 must be free (Caddy obtains the certificate). Without `DOMAIN` the page shows "not set up
yet". Docker panels without Traefik can also use the GitHub link to this file, or repository + path
`deploy/standalone/full`.

### Build it yourself (repo checkout)

```bash
cp .env.example .env     # COMPOSE_FILE=docker-compose.build.yml, DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d     # builds the MCP image, Caddy obtains TLS
```

With `COMPOSE_FILE` in `.env`, every `docker compose …` command works without `-f`. Without `DOMAIN`
(or `MCP_SESSION_SECRET`), `docker compose` stops with a clear message. Local testing without a
domain/TLS (everything on `http://localhost:8090`):

```bash
docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d
```

**Wiki.js itself does not live in this repo:** it runs from the official
`requarks/wiki:2` image, pulled automatically on first start. This repo only
contains the MCP server, the deployment configuration and (for
`docker-compose.build.yml`) a mounted wiki config
([deploy/wiki/config.yml](deploy/wiki/config.yml) — unchanged except for the DB
pool). Updating the wiki = pulling a new image.

## First-run setup (admin account, home page, search)

With `docker-compose.yml` and `deploy/standalone/full` this runs automatically (see above). With
`docker-compose.build.yml` a fresh Wiki.js starts in setup mode; the Compose service `bootstrap` does
everything in one go — **idempotent**, safe to re-run (no Node on the host):

```bash
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='secure-password' \
  docker compose run --rm bootstrap --locale=de
# local test stack: same -f flags as for `up`
#   docker compose -f docker-compose.build.yml -f docker-compose.local.yml run --rm bootstrap --locale=de
```

**Why not in the browser?** Until setup is done, the first call to Wiki.js'
`/finalize` creates the admin account — for anyone who can reach the domain.
Caddy or Traefik therefore block `/finalize` from outside; the `bootstrap` service
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
[`deploy/standalone/mcp-only/docker-compose.yml`](deploy/standalone/mcp-only/docker-compose.yml) and tested
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
| [`docker-compose.yml`](docker-compose.yml) | Full stack behind an existing Traefik (Docker panels): Postgres + Wiki.js + MCP + backup, published image, secrets generated |
| [`deploy/standalone/`](deploy/standalone/) | No repo checkout: `full/` full stack with its own Caddy (80/443), `mcp-only/` MCP only next to an existing wiki |
| [`docker-compose.build.yml`](docker-compose.build.yml) | Full stack built from source: Postgres + Wiki.js + MCP (local build) + Caddy (auto-HTTPS) + daily backup; `docker-compose.local.yml` for local tests |
| [`deploy/caddy/`](deploy/caddy/) | Reverse-proxy routing (one domain for wiki & MCP → one-click SSO) |
| [`deploy/scripts/`](deploy/scripts/) | `bootstrap.mjs` (idempotent first-run setup), `standalone-init.mjs` (secrets, Caddyfile) — both also in the image |
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
