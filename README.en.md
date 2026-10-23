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

![Architecture: AI clients and browser → reverse proxy (one domain) → MCP server (OAuth, policy gate, tools, GraphQL client) → Wiki.js → PostgreSQL on an internal network](mcp-for-wiki-js/docs/architektur.png)

Interactive version with per-component source links (German labels): [docs/architektur.html](mcp-for-wiki-js/docs/architektur.html)
(open locally in a browser; editable archify source: [architektur.archify.json](mcp-for-wiki-js/docs/architektur.archify.json)).

## Installation: which case?

| Case | Starting point | Path | File |
|---|---|---|---|
| **A: Full stack** | no wiki yet | **A1** hosting provider's Docker panel (import from the Git repo, Traefik already running) | [`docker-compose.yml`](docker-compose.yml) |
| | | **A2** own server without a reverse proxy | [`deploy/standalone/full/`](deploy/standalone/full/docker-compose.yml) |
| | | **A3** build it yourself (repo checkout) | [`docker-compose.build.yml`](docker-compose.build.yml) |
| | | **A4** Kubernetes | [Helm chart `wikijs-stack`](deploy/helm/wikijs-stack/README.md) |
| **B: Add MCP to an existing wiki** | Wiki.js is running; MCP under the **same address** | **B1** Traefik in front of the wiki | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) + `TRAEFIK_ENABLE=true` |
| | | **B2** nginx, Caddy, Apache … in front of the wiki | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) + path rules |
| | | **B3** Kubernetes | [Helm chart](deploy/helm/wikijs-mcp/README.md) |
| **C: MCP only** | wiki runs elsewhere, its proxy cannot be changed | **C1** MCP under its own address | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) |
| | | **C2** locally on your own machine (stdio) | [server README](mcp-for-wiki-js/README.en.md) |

All compose files except A3 use the published image `ghcr.io/janschachtschabel/mcp-wiki-js-ai:main`,
need **no required variables** and generate the database password and `MCP_SESSION_SECRET` on first
start (volumes `stack-secrets` and `mcp-secrets`). **Full guide with every path, proxy examples and variables:
[docs/installation-it.en.md](mcp-for-wiki-js/docs/installation-it.en.md).**

### A1: Docker panel with Traefik

For panels that build a project straight from a Git repository. They read only the
`docker-compose.yml` in the repo root, copy `.env.example` to `.env` and allow variables only after
the first successful deployment. Their Traefik holds ports 80/443 on the server.

1. *Compose from URL* (or similar) with `https://github.com/janschachtschabel/mcp-wiki-js-ai` —
   deploy without variables.
2. Edit the project, set `DOMAIN` (hostname only, no `https://`), `ADMIN_EMAIL` and
   `ADMIN_PASSWORD` in `.env`, redeploy. First-run setup runs automatically.
3. Clear `ADMIN_PASSWORD` again, redeploy; create a "Team" group in the wiki without
   `manage:system`.

### A2: Own server without a proxy

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```
A bundled Caddy takes ports 80/443 and obtains the certificate.

### A3: Build it yourself

```bash
cp .env.example .env     # COMPOSE_FILE=docker-compose.build.yml, DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' docker compose run --rm bootstrap --locale=de
```
Locally without a domain: `docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d`
(`http://localhost:8090`).

### A4: Kubernetes (Helm)

```bash
kubectl create namespace wiki
kubectl -n wiki create secret generic wiki-admin --from-literal=ADMIN_PASSWORD='…'
cp deploy/helm/wikijs-stack/values-example.yaml values-wiki.yaml     # adjust domain, admin.email, ingress/TLS
helm install wiki ./deploy/helm/wikijs-stack -n wiki -f values-wiki.yaml
kubectl -n wiki logs job/wiki-bootstrap-1 -f                         # follow first-run setup
```
Postgres, Wiki.js, MCP, Ingress (one domain), first-run setup and a daily backup in one release; the
chart generates the database password and session secret itself (with GitOps: `secrets.existingSecret`).
Details: [chart README](deploy/helm/wikijs-stack/README.md) ·
[guide A4](mcp-for-wiki-js/docs/installation-it.en.md#a4-kubernetes-helm-chart-wikijs-stack).

### B: Add MCP to an existing Wiki.js

```bash
mkdir wikijs-mcp && cd wikijs-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/mcp-only/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nWIKIJS_URL=https://wiki.example.org\n' > .env
docker compose up -d
```
Then either **B1** add `TRAEFIK_ENABLE=true` (Traefik routes the MCP paths via labels) or **B2**
point the MCP paths of your existing proxy to `127.0.0.1:3100` — examples for nginx, Caddy and Apache
in the [guide](mcp-for-wiki-js/docs/installation-it.en.md#b2-nginx-caddy-apache-or-similar-in-front-of-the-wiki).
Kubernetes (**B3**): Helm chart [`wikijs-mcp`](deploy/helm/wikijs-mcp/README.md) with
[`values-prod.example.yaml`](deploy/helm/wikijs-mcp/values-prod.example.yaml) —
[guide B3](mcp-for-wiki-js/docs/installation-it.en.md#b3-wikijs-runs-in-kubernetes).

### C: MCP only

**C1:** the same file as in B with its own address (`DOMAIN=mcp.example.org`,
`WIKIJS_URL=https://wiki.example.org`) and a TLS proxy in front. Users enter
`https://mcp.example.org/mcp`; the consent page then asks for the wiki credentials in a form.
**C2:** one person runs the server locally over stdio with their own Wiki.js API key —
[server README](mcp-for-wiki-js/README.en.md).

## Key environment variables

| Variable | Meaning | Applies to |
|---|---|---|
| `DOMAIN` | hostname of wiki/MCP, **without** `https://` | all compose files |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin account (clear the password afterwards) | A |
| `BOOTSTRAP_ARGS` | `--locale=en` (instead of German), `--demo` (test group + test user) | A1, A2 |
| `WIKIJS_URL` | how the MCP server reaches the existing wiki | B, C1 |
| `TRAEFIK_ENABLE` | switch the Traefik labels on | B1, C1 |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` / `TRAEFIK_NETWORK` | names in the existing Traefik (defaults `websecure` / `letsencrypt` / own network) | A1, B1, C1 |
| `WIKIJS_BLOCKED_TAGS` | tags that lock pages away from the AI (default `kein-ki`) | all |
| `MCP_ALLOWED_REDIRECT_HOSTS` | allowed OAuth redirect hosts, e.g. `claude.ai,chatgpt.com`; leave empty when users choose their AI apps freely (the consent page shows the target) | all |
| `INSTANCE` | prefix of the Traefik routers, only for a second installation behind the same Traefik | A1, B1, C1 |
| `MCP_IMAGE` | another image or a release tag | all |

Complete tables per file: [guide, environment variables](mcp-for-wiki-js/docs/installation-it.en.md#environment-variables) ·
all server variables: [server README](mcp-for-wiki-js/README.en.md) ·
commented template: [`.env.example`](.env.example).

## Usage

| URL | Purpose |
|---|---|
| `https://<DOMAIN>` | Wiki.js |
| `https://<DOMAIN>/mcp` | MCP endpoint — the connector URL for every client |
| `https://<DOMAIN>/me` | view / revoke your own AI connections |
| `https://<DOMAIN>/ki-zugang` | user guide (created by first-run setup) |

```bash
# Claude Code
claude mcp add --transport http wiki https://<DOMAIN>/mcp   # then: /mcp → Authenticate

# claude.ai / Claude Desktop:  Settings → Connectors → Add custom connector → URL
# ChatGPT / Cursor etc.:        add an MCP server / connector with the URL → wiki login starts automatically
```

## Operations

- **Update:** `docker compose pull && docker compose up -d` or redeploy in the panel (A3 also
  `docker compose build --pull mcp`; Kubernetes: `helm upgrade … -f values-wiki.yaml`). Wiki.js runs from the official `requarks/wiki:2` image and can be
  updated independently.
- **Backup:** case A backs up Postgres and the secrets daily into the `db-backups` volume and the MCP
  SQLite into `mcp-backups`. Both live on the same server — **copy them off the server regularly**.
  Restore: [installation guide](mcp-for-wiki-js/docs/installation-it.en.md#backup-and-restore-a1-a2).
- **First-run setup** (`deploy/scripts/bootstrap.mjs`, idempotent): creates the admin account, home
  page, `/ki-zugang`, PostgreSQL search and language. The Wiki.js setup wizard (`/finalize`) is blocked
  from outside so nobody can claim the first admin account before setup.

## Repository layout

| Path | Contents |
|---|---|
| [`mcp-for-wiki-js/`](mcp-for-wiki-js/) | The MCP server (Next.js/TypeScript): 70 tools over the Wiki.js GraphQL API, OAuth layer, permission engine, tests. Details: [README (EN)](mcp-for-wiki-js/README.en.md) · [concept & permission model (EN)](mcp-for-wiki-js/docs/concept-ai-access.en.md) |
| [`docker-compose.yml`](docker-compose.yml) | A1: full stack behind an existing Traefik (Docker panels) |
| [`deploy/standalone/full/`](deploy/standalone/full/) | A2: full stack with its own Caddy (80/443) |
| [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/) | B1/B2/C1: MCP server only, optional Traefik labels |
| [`docker-compose.build.yml`](docker-compose.build.yml) | A3: full stack built from source; `docker-compose.local.yml` for local tests |
| [`deploy/helm/wikijs-stack/`](deploy/helm/wikijs-stack/) | A4: Helm chart template for the full stack (Postgres, Wiki.js, MCP, Ingress, first-run setup, backup) |
| [`deploy/helm/wikijs-mcp/`](deploy/helm/wikijs-mcp/) | B3: Helm chart for the MCP server only |
| [`deploy/scripts/`](deploy/scripts/) | `bootstrap.mjs` (first-run setup), `standalone-init.mjs` (secrets, Caddyfile) — both also in the image |
| [`deploy/caddy/`](deploy/caddy/), [`deploy/wiki/`](deploy/wiki/) | Caddy routing (one domain for wiki & MCP), Wiki.js config for A3 |
| [`Dockerfile`](Dockerfile) | Production image of the MCP server (Next.js standalone, Node 24) |
| [`.github/workflows/`](.github/workflows/), [`.gitlab-ci.yml`](.gitlab-ci.yml) | CI: typecheck/tests/build + image → ghcr.io or company registry + Helm chart |

Not part of the repo (excluded via `.gitignore`): `wiki/` (reference clone of
requarks/wiki) and `mcp2/` (community MCP servers used for comparison).

## Permissions & safeguards — who enforces what?

| Layer | Maintained in | Effect |
|---|---|---|
| Access rights | **Wiki.js** (groups, page rules — per person) | hard, server-side; applies to AI sessions too |
| Area lock-out | Wiki.js: path-based **deny page rule** (e.g. `/internal/*`) | reliable, including search |
| Tag guardrail | Tag (e.g. `kein-ki`) on the page + `WIKIJS_BLOCKED_TAGS` on the MCP server | MCP hides the page from agents (search/list/tree/links/read) and refuses writes/moves/deletes (also comments of blocked pages, even by comment id); exception: `wiki_graphql` |
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

Two Helm charts: [`wikijs-stack`](deploy/helm/wikijs-stack/README.md) (case A4) brings Postgres,
Wiki.js, the MCP server, ingress, first-run setup and backup; [`wikijs-mcp`](deploy/helm/wikijs-mcp/README.md)
(case B3) deploys only the MCP server (StatefulSet + small PVC for the session store) next to an
existing Wiki.js, wired up via `config.wikijs.url`. The GitLab pipeline builds the image, packages/pushes
`wikijs-mcp` and lints `wikijs-stack` — the required CI/CD
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
