# Installation – guide for IT

> 🇩🇪 Deutsche Version: [installation-it.md](installation-it.md)

The MCP server makes a [Wiki.js](https://js.wiki/) 2.x usable for AI tools (Claude, ChatGPT, Cursor …).
Users enter a single address (`https://<domain>/mcp`) and sign in with their normal wiki account; the
AI then works with exactly that person's wiki permissions.

## Which case applies?

| Case | Starting point | Path | File / tool |
|---|---|---|---|
| **A: Full stack** | No wiki yet. Wiki.js and MCP should run together. | **A1** hosting provider's Docker panel, import from the Git repo, Traefik already running there | [`docker-compose.yml`](../../docker-compose.yml) (repo root) |
| | | **A2** own server without a reverse proxy | [`deploy/standalone/full/docker-compose.yml`](../../deploy/standalone/full/docker-compose.yml) |
| | | **A3** build it yourself (repo checkout, own registry, development) | [`docker-compose.build.yml`](../../docker-compose.build.yml) |
| | | **A4** Kubernetes | [Helm chart `wikijs-stack`](../../deploy/helm/wikijs-stack/README.md) |
| **B: Add MCP to an existing wiki** | Wiki.js already runs under a domain. The MCP joins under the **same address**; the wiki stays unchanged. | **B1** Traefik in front of the wiki (your own or a Docker panel's) | [`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml) with `TRAEFIK_ENABLE=true` |
| | | **B2** nginx, Caddy, Apache or similar in front of the wiki | the same file + path rules in the proxy |
| | | **B3** Wiki.js runs in Kubernetes | [Helm chart](../../deploy/helm/wikijs-mcp/README.md) |
| **C: MCP only** | Wiki.js runs elsewhere and the wiki domain's proxy cannot be changed (e.g. hosted by a third party). | **C1** MCP under its own address (e.g. `mcp.example.org`) | [`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml) |
| | | **C2** one person uses the MCP locally on their own machine | `npm run stdio` with a personal API key |

**Common rules**

- **Same domain for wiki and MCP** (cases A and B): the wiki session then also counts when connecting
  the AI — one click on "Allow" instead of a second login. With a separate address (C1) everything
  works the same, only the consent page asks for the wiki credentials in a form.
- The MCP server runs as its **own container/pod**, not inside the wiki container.
- These paths belong to the MCP server; do **not** create wiki pages there:
  `/mcp`, `/oauth/…`, `/me`, `/_next/…`, `/api/health`, `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/.well-known/mcp.json`.
- **Never** give AI users `manage:system` in Wiki.js — it bypasses all page rules.
- The compose files for A1, A2, B1, B2 and C1 pull the published image
  `ghcr.io/janschachtschabel/mcp-wiki-js-ai:main` (public, no login), need **no required variables**
  and generate their secrets on first start (service `init`, volume `stack-secrets` — include it in
  backups).

---

## A: Wiki.js and MCP as a full stack

All paths bring Postgres, Wiki.js, the MCP server and a daily backup. First-run setup (admin
account, home page, user guide `/ki-zugang`, PostgreSQL search, language) runs automatically in A1, A2
and A4 once the domain and admin credentials are set. Always required: a DNS A record of the
domain pointing to the server.

### A1: Docker panel with Traefik (import from the Git repo)

Some hosting providers' Docker panels build projects straight from a Git repository. Observed
behaviour the file accounts for:

- The panel reads **only the `docker-compose.yml` in the repo root** (a path to a subfolder in the URL
  is ignored) and copies `.env.example` to `.env`.
- Variables can only be edited once the project exists — and it only exists if the first deployment
  succeeds. A failure merely shows up as "deployment failed" or "Docker project not found".
- A **Traefik** already runs on ports 80/443 (host network mode) with the HTTPS entrypoint `websecure`
  and the certificate resolver `letsencrypt`.

**Steps**

1. In the panel use *Compose from URL* (or similar) with `https://github.com/janschachtschabel/mcp-wiki-js-ai`
   and deploy without variables. All containers start; `init` and `bootstrap` exit afterwards (status
   "Exited" is normal for them).
2. Edit the project, set these in `.env` and redeploy:
   ```
   DOMAIN=wiki.example.org        # hostname only — no https://, no path
   ADMIN_EMAIL=admin@example.org
   ADMIN_PASSWORD=…
   ```
   Without a domain of your own, the hostname the provider gives the server (e.g.
   `srv123456.<provider-domain>`) works as long as its DNS points to the server.
3. After a minute or two check: `https://<DOMAIN>/api/health` returns `{"ok":true,"store":"ok"}`; the
   log of the `bootstrap` container ends with "Fertig".
4. Clear `ADMIN_PASSWORD` and redeploy; then continue with [After setup](#after-setup).

Traefik handles HTTPS and the certificate. Via labels the MCP paths go to the MCP server, everything
else to Wiki.js; `/finalize` (the Wiki.js setup wizard that creates the first admin account) goes to
the MCP server and ends there with 404. The file needs no pre-existing Docker network: it creates its
own network `wikijs-web`. If Traefik does not run in host mode but in its own Docker network, set that
network's name as `TRAEFIK_NETWORK` (variables: [full stacks only](#full-stacks-only-a)).

### A2: Own server without a reverse proxy

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```

A bundled **Caddy** takes ports 80/443 and obtains the certificate itself. `init` writes its
configuration from the template [`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile) (shipped in the
image); without `DOMAIN` the page shows "not set up yet". If 80/443 are already taken (another proxy on
the server), use A1, or put Wiki.js behind that proxy and add the MCP as in B. Docker panels **without**
Traefik that support subfolders can import this file via repository + path `deploy/standalone/full` —
then in two steps as in A1.

### A3: Build it yourself (repo checkout)

```bash
git clone https://github.com/janschachtschabel/mcp-wiki-js-ai.git && cd mcp-wiki-js-ai
cp .env.example .env
```
Set in `.env` (with `COMPOSE_FILE`, every `docker compose …` command works without `-f`):
```
COMPOSE_FILE=docker-compose.build.yml
DOMAIN=wiki.example.org
POSTGRES_PASSWORD=<openssl rand -base64 24>
MCP_SESSION_SECRET=<openssl rand -base64 32>
```
Start and set up:
```bash
docker compose up -d
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' docker compose run --rm bootstrap --locale=de
```
The image is built locally, Caddy takes 80/443, Wiki.js gets a larger DB pool
([`deploy/wiki/config.yml`](../../deploy/wiki/config.yml)). Caddy answers the setup endpoint `/finalize`
from outside with 403; `bootstrap` talks to Wiki.js directly inside the Docker network. Local testing
without a domain/TLS: `docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d`
(then `http://localhost:8090`); run the setup with the same `-f` flags before `run --rm bootstrap`.

### A4: Kubernetes (Helm chart `wikijs-stack`)

One release brings PostgreSQL (with a NetworkPolicy: only the wiki and the backup may connect),
Wiki.js, the MCP server, the Ingress for **one** domain (MCP paths → MCP, `/finalize` blocked, everything
else → Wiki.js), first-run setup as a Job and a daily database backup as a CronJob. Requirements: an
ingress controller (e.g. nginx or Traefik), a default StorageClass, a DNS record of the domain pointing
to the ingress and a TLS certificate (existing Secret or cert-manager).

1. **Get the repo and store the admin password as a Secret** (keeps it out of the Helm history):
   ```bash
   git clone https://github.com/janschachtschabel/mcp-wiki-js-ai.git && cd mcp-wiki-js-ai
   kubectl create namespace wiki
   kubectl -n wiki create secret generic wiki-admin --from-literal=ADMIN_PASSWORD='…'
   ```
2. **Create a values file:** `cp deploy/helm/wikijs-stack/values-example.yaml values-wiki.yaml` and replace
   the placeholders — at least `domain` (hostname only) and `admin.email`; also `ingress.className`
   (`nginx`/`traefik`) and `ingress.tls.secretName`. With cert-manager add e.g.
   `cert-manager.io/cluster-issuer: letsencrypt` under `ingress.wikiAnnotations`.
3. **Install:**
   ```bash
   helm install wiki ./deploy/helm/wikijs-stack -n wiki -f values-wiki.yaml
   ```
   Without a values file:
   ```bash
   helm install wiki ./deploy/helm/wikijs-stack -n wiki --set domain=wiki.example.org --set admin.email=admin@example.org --set admin.existingSecret=wiki-admin
   ```
4. **Follow and check the setup:**
   ```bash
   kubectl -n wiki get pods
   kubectl -n wiki logs job/wiki-bootstrap-1 -f
   curl https://wiki.example.org/api/health
   ```
   The job ends with "Fertig"; `/api/health` returns `{"ok":true,"store":"ok"}`.
5. **Clean up:** `helm upgrade … --set bootstrap.enabled=false` (or in the values file), then the
   `wiki-admin` Secret can be deleted. While `bootstrap.enabled=true`, the chart requires `admin.email` and
   `admin.existingSecret` — the Job then creates the admin account right at install and the Wiki.js setup
   wizard is never left open (with an nginx ingress `/finalize` cannot be blocked in every spelling).

**Secrets:** the chart generates the database password and `MCP_SESSION_SECRET` once in the Secret
`<release>-secrets` and keeps them across upgrades and `helm uninstall`. This does not work with GitOps
tools (Argo CD, Flux) or `helm template` — create the Secret beforehand and pass it as
`secrets.existingSecret`:
```bash
kubectl -n wiki create secret generic wiki-secrets --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" --from-literal=MCP_SESSION_SECRET="$(openssl rand -base64 32)"
```

**Own registry/mirror:** set `images.mcp`, `images.wiki`, `images.postgres` (repository and tag) and
`images.pullSecrets`. All values: [Helm values](#helm-charts-a4-b3) and
[chart README](../../deploy/helm/wikijs-stack/README.md).

### After setup

1. For A1/A2 clear `ADMIN_PASSWORD` and redeploy (the account stays); for A4 set
   `bootstrap.enabled=false` and delete the `wiki-admin` Secret.
2. In the wiki under Administration → Groups create a "Team" group: read/write pages, assets and
   comments, plus `read:source` and `read:history` — **without** `manage:system`.
3. Create users (Administration → Users) and add them to the group. Without a configured mail server
   (Administration → Mail) set their passwords yourself.
4. Give users the address `https://<DOMAIN>/mcp` — the guide is already in the wiki at
   `https://<DOMAIN>/ki-zugang` (German).

---

## B: Add MCP to an existing Wiki.js (same address)

The wiki stays untouched (no fork, no migration). The MCP server runs next to it, and the proxy in
front of the wiki hands the MCP paths to it. B1 and B2 need **one** file,
[`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml):

```bash
mkdir wikijs-mcp && cd wikijs-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/mcp-only/docker-compose.yml
```

It starts without variables (`init` generates the session secret). Set at least:

```
DOMAIN=wiki.example.org                     # the wiki's hostname (no https://)
WIKIJS_URL=https://wiki.example.org         # how the MCP reaches the wiki (see below)
```

**Choosing `WIKIJS_URL`:** the wiki domain always works. `http://host.docker.internal:3000` (default)
fits when Wiki.js runs on the same host with port 3000 published — not if the port is bound to
`127.0.0.1` only. If the wiki domain uses a company-internal certificate, see
[Addresses](#addresses-wikijs_url-and-domain).

### B1: Traefik in front of the wiki

Additionally set `TRAEFIK_ENABLE=true` and start (`docker compose up -d`, or in a panel via *Compose
manually* with the file's content). The MCP container then carries Traefik labels: on `DOMAIN` only the
MCP paths go to it (priority 100); all other requests keep their existing router to the wiki.
Requirements:

- Traefik can reach the MCP container's network: automatically in host mode; if Traefik runs in its own
  Docker network, set that network's name as `TRAEFIK_NETWORK`.
- Entrypoint and resolver names match (`TRAEFIK_ENTRYPOINT`, default `websecure`;
  `TRAEFIK_CERTRESOLVER`, default `letsencrypt`).
- The wiki's router has no priority above 100 (the default is the rule's length, i.e. much lower).

### B2: nginx, Caddy, Apache or similar in front of the wiki

The MCP listens locally on `127.0.0.1:3100` only (`MCP_PORT`). In the existing proxy of the wiki domain
route the MCP paths there; everything else stays with the wiki. Important for every proxy: **append**
`X-Forwarded-For` (the login limit counts per client IP) and do **not buffer** responses (streaming).
All three examples are tested with this project.

**nginx** — inside the existing `server { … }` block of the wiki domain (regex locations take
precedence over the wiki's `location /`):
```nginx
location ~ ^/(mcp(/|$)|oauth/|me(/|$)|_next/|api/health$|\.well-known/(oauth-authorization-server|oauth-protected-resource|mcp\.json)) {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    client_max_body_size 8m;
}
```

**Caddy** — inside the existing site block; the previous `reverse_proxy` to the wiki moves into the
last `handle`:
```caddy
wiki.example.org {
	@mcp {
		path /mcp /mcp/* /oauth/* /me /me/* /api/health /_next/*
		path /.well-known/oauth-authorization-server* /.well-known/oauth-protected-resource* /.well-known/mcp.json
	}
	handle @mcp {
		reverse_proxy 127.0.0.1:3100
	}
	handle {
		reverse_proxy 127.0.0.1:3000   # existing Wiki.js (previous target)
	}
}
```

**Apache** (`mod_proxy`, `mod_proxy_http`, `mod_headers`) — inside the wiki domain's
`<VirtualHost *:443>`, **before** the `ProxyPass` for the wiki:
```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"
ProxyPassMatch "^/(mcp(/.*)?|oauth/.*|me(/.*)?|_next/.*|api/health|\.well-known/(oauth-authorization-server.*|oauth-protected-resource.*|mcp\.json))$" "http://127.0.0.1:3100/$1" flushpackets=on
```

Other proxies (panel proxies, HAProxy …): the same paths via a path rule to `127.0.0.1:3100`.

**Without Compose:** the same values with `docker run`, e.g. in the wiki's Docker network:
```bash
docker run -d --name wikijs-mcp --restart unless-stopped --network <wiki-network> \
  -p 127.0.0.1:3100:3000 -v mcp-data:/data \
  -e WIKIJS_URL=http://<wiki-container>:3000 -e PUBLIC_BASE_URL=https://wiki.example.org \
  -e MCP_SESSION_SECRET="$(openssl rand -base64 32)" \
  ghcr.io/janschachtschabel/mcp-wiki-js-ai:main
```
(Note the secret and reuse it whenever you recreate the container, otherwise all connections are lost.)

### B3: Wiki.js runs in Kubernetes

1. **Create the secret** (kept out of values files and Helm history):
   ```bash
   kubectl -n <namespace> create secret generic wikijs-mcp-secret \
     --from-literal=MCP_SESSION_SECRET="$(openssl rand -base64 32)"
   ```
2. **Set values:** `cp deploy/helm/wikijs-mcp/values-prod.example.yaml values-prod.yaml`, then:
   ```yaml
   global:
     image:
       registry: ghcr.io                                 # or your own registry
       repository: janschachtschabel/mcp-wiki-js-ai
   image:
     tag: "main"                                         # better: a release tag
   config:
     existingSecret: wikijs-mcp-secret
     wikijs:
       url: http://<wiki-service>.<namespace>.svc:3000   # internal service, without /graphql
     oauth:
       publicBaseUrl: https://wiki.example.org           # public wiki domain
   ingress:
     hosts: [wiki.example.org]                           # SAME domain as the wiki
     tls:
       - secretName: wiki-tls                            # existing certificate
         hosts: [wiki.example.org]
   ```
3. **Deploy:** `helm install wikijs-mcp deploy/helm/wikijs-mcp -n <namespace> -f values-prod.yaml`

The chart creates an ingress on the wiki domain for the MCP paths only (`Exact` for single paths, `Prefix`
only with a trailing `/`, Traefik priority 100 — so wiki pages like `/meeting` stay with the wiki); `replicaCount` stays **1**
(sessions live in a SQLite file on the PVC). Own image: in the repo root
`docker build -t <registry>/<path>:<tag> .` and push. Details: [Helm README](../../deploy/helm/wikijs-mcp/README.md).

### After setup (B)

1. Check: `https://<domain>/api/health` → `{"ok":true,"store":"ok"}`;
   `https://<domain>/.well-known/oauth-authorization-server` → JSON; `https://<domain>/` → still the wiki.
2. Create the "Team" group as in [A — After setup](#after-setup) (without `manage:system`).
3. Recommended: Administration → Search Engine → **PostgreSQL** (dictionary matching the language) —
   much better search for AI agents. If Wiki.js uses the default DB pool (10 connections), keep
   `WIKIJS_MAX_CONCURRENCY` at `6`.

---

## C: MCP server only

### C1: MCP under its own address (wiki runs elsewhere)

For a wiki whose proxy you cannot change. The MCP gets its own domain, e.g. `mcp.example.org`, with the
same file as in B:

```
DOMAIN=mcp.example.org                      # the MCP's address (DNS → this server)
WIKIJS_URL=https://wiki.example.org         # the existing wiki
```

Put a TLS proxy in front — either an existing Traefik (`TRAEFIK_ENABLE=true`, labels as in B1) or e.g. a
Caddy on the server:
```caddy
mcp.example.org {
	reverse_proxy 127.0.0.1:3100
}
```
Users enter `https://mcp.example.org/mcp`. Because the wiki session does not apply on this domain, the
consent page asks once for the wiki credentials in a form; permissions, guardrails and `/me` work
unchanged. The MCP needs network access to the wiki (GraphQL over HTTPS).

### C2: Locally on your own machine (one person)

No server: Claude Desktop or another client starts the MCP server locally over stdio, using a
**personal Wiki.js API key** (Administration → API Access). Permissions then belong to the key, not to
the person. Example for Claude Desktop (`claude_desktop_config.json`, repo checked out and
`npm install` run in `mcp-for-wiki-js/`):
```jsonc
{
  "mcpServers": {
    "wikijs": {
      "command": "npm",
      "args": ["--prefix", "/ABSOLUTE/PATH/to/mcp-for-wiki-js", "run", "stdio"],
      "env": {
        "WIKIJS_URL": "https://your-wiki.example.org",
        "WIKIJS_TOKEN": "YOUR_WIKIJS_API_KEY",
        "WIKIJS_PERMISSION_PRESET": "editor"
      }
    }
  }
}
```

---

## Addresses: `WIKIJS_URL` and `DOMAIN`

| Variable | Purpose | Examples |
|---|---|---|
| `WIKIJS_URL` | how the MCP server reaches the wiki (GraphQL) — internal or public | `http://wiki:3000` (same compose network), `http://<service>.<namespace>.svc:3000` (Kubernetes), `http://host.docker.internal:3000` (same host), `https://wiki.example.org` |
| `DOMAIN` | the hostname users and AI tools use to reach the MCP; `PUBLIC_BASE_URL=https://<DOMAIN>` is derived from it | `wiki.example.org` (cases A/B), `mcp.example.org` (C1) |

An IP is never needed; any domain works. If wiki and MCP share a Docker network or cluster, the
internal address is the more robust choice. If the wiki domain uses a **company-internal
certificate**, Node must know the CA: mount the PEM file into the container and set
`NODE_EXTRA_CA_CERTS=/path/ca.pem` (Compose: via an override file); with the Helm chart use the internal
service address over `http://` instead.

---

## Environment variables

### All compose files (in the `.env` next to the file, or in the panel)

| Variable | Meaning | Default |
|---|---|---|
| `DOMAIN` | hostname, **without** `https://` and without a path. If it contains `https://`, `init` stops with a clear message | empty (A1/A2/B/C1: empty allowed at first) · A3: required |
| `WIKIJS_BLOCKED_TAGS` | pages with these tags are invisible and locked for the AI (comma-separated, empty = off) | `kein-ki` |
| `WIKIJS_MAX_CONCURRENCY` | max. concurrent requests to Wiki.js (keep below the wiki's DB pool) | `6` (A3: `12`) |
| `WIKIJS_OAUTH_ROLE` | protection role for AI sessions: delete/admin only after a confirmation step | `wiki` |
| `WIKIJS_PERMISSION_PRESET` | ceiling of visible tools; keep `full` with OAuth (permissions come from Wiki.js) | `full` |
| `WIKIJS_AUDIT` | audit log (tool, user, result) on/off | `true` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | AI clients may only redirect to these hosts after login (comma-separated, e.g. `claude.ai,chatgpt.com`); apps on the user's own computer (localhost) are always allowed. **Leave empty when users choose their AI apps freely** — the consent page then shows where the login goes before every connection; the server only logs a notice at start. Set it once you know which clients are used | empty = any https host |
| `MCP_IMAGE` | another image/tag, e.g. a release tag `ghcr.io/janschachtschabel/mcp-wiki-js-ai:v1.2.3` | `…:main` (A3: `wikijs-mcp:local`) |
| `TZ` | time zone of the timestamps on `/me` | `UTC` |

### Full stacks only (A)

| Variable | Meaning | Default |
|---|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin account. A1/A2: created on start, clear `ADMIN_PASSWORD` afterwards. A3: used by `run --rm bootstrap` | – |
| `BOOTSTRAP_ARGS` | extra first-run setup flags (A1/A2): `--locale=en` (other language; German is the default), `--demo` (group "Team" + test user, for tests only; needs `DEMO_PASSWORD`, optionally `DEMO_EMAIL`, `DEMO_NAME`), `--reapply` (set language, search engine and group rights again — otherwise only at first setup) | – |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` | interval and number of backups (Postgres + secrets in `db-backups`, MCP SQLite in `mcp-backups`; see [Backup](#backup-and-restore-a1-a2)) | `86400` / `7` |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` | names in the existing Traefik (A1 only) | `websecure` / `letsencrypt` |
| `TRAEFIK_NETWORK` | network through which Traefik reaches the stack; created if missing. Change only if Traefik runs in its own Docker network (A1 only) | `wikijs-web` |
| `INSTANCE` | prefix of the Traefik routers; set your own name for a **second** installation behind the same Traefik (e.g. staging) (A1, B1/C1) | `wikijs` or `wikijs-mcponly` |
| `HTTP_PORT` / `HTTPS_PORT` | host ports of the bundled Caddy (A2 only; keep 80/443 for Let's Encrypt) | `80` / `443` |
| `COMPOSE_FILE` | `docker-compose.build.yml` — then `docker compose …` works without `-f` (A3 only) | – |
| `POSTGRES_PASSWORD`, `MCP_SESSION_SECRET` | required for A3 only; A1/A2 generate them | – |
| `PUBLIC_BASE_URL` | different public address (A3 only) | `https://$DOMAIN` |
| `WIKIJS_DB_POOL_MIN` / `WIKIJS_DB_POOL_MAX` | Wiki.js DB pool (A3 only) | `2` / `20` |

### MCP-only file (B1, B2, C1)

| Variable | Meaning | Default |
|---|---|---|
| `WIKIJS_URL` | address of the existing wiki (without `/graphql`) | `http://host.docker.internal:3000` |
| `MCP_PORT` | local port for a proxy on the host (bound to `127.0.0.1` only) | `3100` |
| `TRAEFIK_ENABLE` | `true` = Traefik labels active (B1, C1 with Traefik) | `false` |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` / `TRAEFIK_NETWORK` | as in A1 | `websecure` / `letsencrypt` / `wikijs-mcp-web` |

### Helm charts (A4, B3)

Values for `helm install … -f <file>` or `--set`. Fully commented in the charts' `values.yaml`.

| Value | Chart | Meaning | Default |
|---|---|---|---|
| `domain` | wikijs-stack | hostname of wiki and MCP, without `https://` (required) | – |
| `admin.email`, `admin.existingSecret` | wikijs-stack | first admin account; Secret with key `ADMIN_PASSWORD`. Required while `bootstrap.enabled=true` | – |
| `bootstrap.enabled` | wikijs-stack | first-run setup Job; set to `false` after setup | `true` |
| `bootstrap.args`, `bootstrap.demoPasswordSecret`, `bootstrap.demoEmail` | wikijs-stack | first-run setup flags (`--locale=en`, `--demo`) | `--locale=de` |
| `secrets.existingSecret` | wikijs-stack | own Secret with `POSTGRES_PASSWORD` and `MCP_SESSION_SECRET` — required with GitOps/`helm template` | empty = generated |
| `images.mcp.tag` / `image.tag` | stack / mcp | MCP image tag; use a release tag in production | `main` |
| `images.*.repository`, `images.pullSecrets` / `global.image.*` | stack / mcp | own registry or mirror | GHCR / Docker Hub |
| `ingress.className` / `global.cluster.ingress.ingressClassName` | stack / mcp | ingress class | `nginx` |
| `ingress.tls.*` / `ingress.tls` | stack / mcp | TLS Secret for the domain | stack: on, `<release>-tls` |
| `ingress.wikiAnnotations` | wikijs-stack | e.g. a cert-manager issuer (wiki Ingress only) | – |
| `ingress.mcpPaths` / `ingress.paths` | stack / mcp | MCP server paths (`Exact`/`Prefix`; strings count as `Prefix`) | see `values.yaml` |
| `config.wikijs.url`, `config.oauth.publicBaseUrl`, `config.existingSecret`, `ingress.hosts` | wikijs-mcp | wiki address, public address, Secret with `MCP_SESSION_SECRET`, domain | – (required) |
| `mcp.config.*` / `config.policy.*`, `config.oauth.role`, `config.extraEnv` | stack / mcp | `blockedTags`, protection role, redirect hosts, time zone, extra variables | as in Compose |
| `postgres.persistence.size`, `mcp.persistence.size` / `persistence.size` | stack / mcp | storage sizes | `5Gi`, `1Gi` |
| `backup.schedule`, `backup.keep`, `backup.persistence.size` | wikijs-stack | schedule and number of `pg_dump` backups | `30 2 * * *`, `7`, `5Gi` |
| `backup.mcpStore.enabled`, `.intervalSeconds`, `.size` | wikijs-stack | sidecar in the MCP pod backing up the MCP database into the PVC `<release>-mcp-backups` | `true`, `86400`, `1Gi` |
| `networkPolicy.ingressFrom` | wikijs-stack | who may reach Wiki.js and the MCP server (usually the ingress controller's namespace, examples in `values.yaml`); empty = cluster-wide | `[]` |
| `publicBaseUrl` | wikijs-stack | only for tests without TLS or on another port | `https://<domain>` |

All other server variables (legacy access with API keys, limits, diagnostics):
[complete reference in the server README (German)](../README.md#vollständige-env-referenz). The server
validates its configuration on start and **refuses to start on errors**; the cause is logged with the
prefix `[wikijs-mcp]`.

---

## How users connect

Users need **just one address** — no keys, no extra accounts: `https://<domain>/mcp`

1. Enter it in the AI tool:
   - **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom connector* → URL
   - **Claude Code:** `claude mcp add --transport http wiki https://<domain>/mcp`, then `/mcp` → *Authenticate*
   - **ChatGPT, Cursor etc.:** add an MCP server or connector with the URL
2. On first connect a browser opens with the wiki login. Sign in with the normal wiki account — or, if
   already signed in, click "Allow".
3. Done. The AI works with that person's wiki permissions; the wiki does not need to be open.

Good to know: delete and admin actions first return a preview (the AI confirms in a second step
itself — a brake, not a human approval). Pages tagged `kein-ki` are invisible to the AI. Users view and
revoke their connections at `https://<domain>/me`. In case A the user guide already exists in the wiki
at `/ki-zugang`.

---

## Operations

| Task | How |
|---|---|
| Update | `docker compose pull && docker compose up -d` or redeploy in the panel (A3 also `docker compose build --pull mcp`). `:main` follows the main branch; pin releases via `MCP_IMAGE` with a release tag |
| Update (Kubernetes) | `helm upgrade wiki ./deploy/helm/wikijs-stack -n wiki -f values-wiki.yaml` (B3 likewise with `wikijs-mcp`); with tag `main` every restart pulls the current image, e.g. `kubectl -n wiki rollout restart statefulset/wiki-mcp` |
| Logs | `docker compose logs -f <service>` or in the panel; useful: `init`, `bootstrap`, `mcp`. Kubernetes: `kubectl -n wiki logs statefulset/wiki-mcp`, `… job/wiki-bootstrap-<revision>` |
| Backup | Case A1/A2: daily into the volumes `db-backups` (Postgres + secrets) and `mcp-backups` (MCP database) — **copy them off the server regularly**; restore see [below](#backup-and-restore-a1-a2). A3: `db-backups` and `mcp-backups` plus the `.env` |
| Change the domain later | change `DOMAIN` and redeploy; in the wiki also update the site URL (Administration → General) and the `/ki-zugang` page; reconnect AI tools |
| Backup (Kubernetes, A4) | the CronJob writes daily into the PVC `<release>-backups`, a sidecar the MCP database into `<release>-mcp-backups` — copy them out of the cluster; also back up the Secret `<release>-secrets` (`kubectl -n wiki get secret <release>-secrets -o yaml`, keep it confidential). Restore: `kubectl -n wiki exec -i wiki-postgres-0 -- pg_restore -U wikijs -d wiki --clean < wiki-<date>.dump` |
| Run the first-time setup again | The automatic `bootstrap` on every deploy only creates what is missing; it sets language, search engine and the rights of the "Team" group only at first setup — changes made in Wiki.js are kept. To set them again on purpose: deploy once with `BOOTSTRAP_ARGS=--reapply` (with `ADMIN_EMAIL`/`ADMIN_PASSWORD`), then remove it. A3: `docker compose run --rm bootstrap --locale=de` |
| Delete everything | `docker compose down -v` (**deletes all data**). Kubernetes: `helm uninstall wiki -n wiki` keeps the Secret `<release>-secrets` and the backup PVC; remove the database and MCP PVCs with `kubectl -n wiki delete pvc …` |


### Backup and restore (A1, A2)

The stack backs up daily (`BACKUP_INTERVAL_SECONDS`, keeping `BACKUP_KEEP` copies):

| Volume | Contents | Service |
|---|---|---|
| `<project>_db-backups` | `wiki-<time>.dump` (Postgres, all wiki content) and `secrets-<time>.tar.gz` (DB password, `MCP_SESSION_SECRET`) | `db-backup` |
| `<project>_mcp-backups` | `mcp-<time>.sqlite` (AI connections, audit log) | `mcp-backup` |

Interrupted runs leave no partial files. The backup services run without root (user 1000); the
files in `db-backups` are readable by that user only, as they contain secrets.

> **Important:** both volumes live on the same server as the wiki. They do not help if the server
> fails — copy them off the server regularly (another server, object storage, the provider's
> snapshot). Example of a copy into the current directory on the server:
>
> ```bash
> docker run --rm -v <project>_db-backups:/b:ro -v <project>_mcp-backups:/m:ro -v "$PWD":/out alpine \
>   tar czf /out/wiki-backup-$(date +%F).tar.gz -C / b m
> ```

**Restore the wiki** (in the project folder or via the panel's console; list the files with
`docker compose exec db-backup ls /backups`):

```bash
docker compose stop wiki mcp
docker compose exec db-backup sh -c 'PGPASSWORD="$(cat /stack/secrets/postgres_password)" pg_restore -h wikijs-db -U wikijs -d wiki --clean --if-exists /backups/wiki-<time>.dump'
docker compose start wiki mcp
```

(In the Caddy variant A2 the database host is `db` instead of `wikijs-db`.)

**Restore the MCP database** (AI connections and audit log):

```bash
docker compose stop mcp
docker run --rm --user 1000:1000 -v <project>_mcp-data:/data -v <project>_mcp-backups:/backups:ro alpine \
  sh -c 'rm -f /data/mcp.sqlite-wal /data/mcp.sqlite-shm && cp /backups/mcp-<time>.sqlite /data/mcp.sqlite'
docker compose start mcp
```

**Notes on updating to the state of 2026-10-23** (A1/A2):

- Pull the new image first (`docker compose pull`; in a panel, redeploy with the current image).
  An older cached `:main` keeps working, only the new `mcp-backup` service will not start.
- On its first start `init` moves `MCP_SESSION_SECRET` unchanged into the new volume `mcp-secrets` —
  existing AI connections stay valid. Going back to an older compose file afterwards creates a new
  secret: the AI apps then have to reconnect.
- The Postgres backup now runs without root. A `db-backups` volume from an older installation is
  owned by root though — hand it over once, otherwise `db-backup` reports "backup FAILED":
  `docker run --rm -v <project>_db-backups:/b alpine chown -R 1000:1000 /b`. Old `mcp-*.sqlite` copies in
  it are no longer rotated and can be deleted.
- If a Wiki.js update runs a long database migration, `docker compose up` waits up to about eight
  minutes for the wiki's healthcheck; if it reports an error after that, the stack still runs —
  `bootstrap` then starts with the next deploy.

**Move to a new server** (tested):

1. Deploy a new stack with the same `DOMAIN`, **without** `ADMIN_EMAIL`/`ADMIN_PASSWORD`. It creates its
   own passwords — keep them: Postgres takes its password only on the very first start, the old
   `postgres_password` from the archive no longer matches.
2. Copy the dump into `<new>_db-backups`, the MCP copy into `<new>_mcp-backups` and only
   `mcp-secrets/session.env` from the archive into `<new>_mcp-secrets` (keeps the AI connections valid;
   without it they reconnect). The current folder holds the files brought over from the old server:

   ```bash
   docker run --rm --user 1000:1000 -v "$PWD":/old:ro -v <new>_db-backups:/backups -v <new>_mcp-backups:/mb -v <new>_mcp-secrets:/m alpine \
     sh -c 'cp /old/wiki-<time>.dump /backups/ && cp /old/mcp-<time>.sqlite /mb/ && tar -xzf /old/secrets-<time>.tar.gz -C /tmp mcp-secrets/session.env && cp /tmp/mcp-secrets/session.env /m/'
   ```
3. Restore the wiki as above (`stop wiki mcp` → `pg_restore` → `start wiki mcp`), then the MCP database.
   Log in with the accounts of the old wiki.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel: "deployment failed" / "Docker project not found" | The first deployment failed. The real message is in the panel's project folder (e.g. `/docker/<project>/.build.log`, via the web console) |
| `init` log: "DOMAIN=… ist kein reiner Hostname" | `DOMAIN` contains `https://` or a path — enter the hostname only |
| Domain returns Traefik's `404 page not found` with "TRAEFIK DEFAULT CERT" | Traefik has no route: `DOMAIN` empty or wrong, `TRAEFIK_ENABLE` missing (B1/C1), or names differ (`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`, `TRAEFIK_NETWORK`). Read the Traefik container's log |
| `network … declared as external, but could not be found` | older version of the file — import again (current files create their own network) |
| Ports 80/443 taken ("address already in use") | a proxy already runs on the server — use A1 or B instead of A2/A3 |
| Panel: "YAML file cannot be processed" | import again; if that does not help, start via SSH with `docker compose up -d` |
| `docker compose` stops with "DOMAIN fehlt" | A3 only: `DOMAIN` empty in `.env` |
| `bootstrap`: "Admin-Login schlägt fehl" | the wiki is already set up and `ADMIN_PASSWORD` no longer matches — clear the variable |
| `/mcp` returns the wiki page | MCP paths missing in the proxy or matched too late (order/priority) |
| Login shows a form instead of one click | wiki and MCP not on the same domain (normal for C1) or a cookie/tracking blocker in the browser |
| OAuth errors / wrong redirects | `DOMAIN` or `PUBLIC_BASE_URL` does not match the address users enter |
| "Zu viele Anmeldeversuche" (too many login attempts) | login limit: 10 attempts per IP or 5 per account within 15 minutes |
| Client registration returns `429` | more than 20 registrations per IP and hour |
| `/api/health` returns `503` | session store (SQLite under `/data`) unavailable — check volume/permissions |
| Sessions gone after a restart | `/data` or `stack-secrets` are not persistent volumes |
| Kubernetes: wiki pages like `/meeting` end up at the MCP, or `/me` at the wiki | older chart version with `Prefix` paths and no Traefik priority — update the chart (`Exact` paths + `traefik.ingress.kubernetes.io/router.priority`) |
| Kubernetes: `wiki` pods restart, log "password authentication failed" | database created with a different password than the Secret holds — do not delete/regenerate `<release>-secrets`; use `secrets.existingSecret` with GitOps |
| Kubernetes: `helm install` fails with "admin.email is required …" | first-run setup is active (`bootstrap.enabled=true`) but admin credentials are missing — set them, or after setup `bootstrap.enabled=false` |
| `413 Payload Too Large` | request over 4 MB (e.g. a large file via the AI) — upload the file directly in the wiki |

More: [concept & permission model](./concept-ai-access.en.md) · [OAuth (German)](./oauth.md) ·
[server README](../README.en.md)
