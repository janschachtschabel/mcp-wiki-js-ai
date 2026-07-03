# Wiki.js + MCP — Team-Wissensspeicher für Menschen & KI-Agenten

> 🇬🇧 English version: [README.en.md](README.en.md)

Ein [Wiki.js](https://js.wiki/)-Wiki, das KI-Agenten (Claude, ChatGPT/Codex,
Cursor, …) über das **Model Context Protocol** sicher mitbenutzen können:

- **Eine geheimnislose Connector-URL für alle** (`https://<domain>/mcp`) — keine
  Keys, keine Personendaten in der URL.
- **Der Wiki-Login ist der einzige Login** (OAuth 2.1): Beim ersten Verbinden
  autorisiert man den Client mit seinem normalen Wiki.js-Konto — ein Klick,
  wenn man im Wiki schon angemeldet ist. Keine doppelte User-Pflege.
- **Rechte pro Person, durchgesetzt von Wiki.js selbst** (Gruppen + Page-Rules);
  der MCP-Server ergänzt Agenten-Schutz: Dry-Run-`confirm` vor destruktiven
  Aktionen und eine **Tag-Sperre** (`kein-ki`), die Seiten für KI unsichtbar macht.
- **Selbstverwaltung unter `/me`**: eigene KI-Verbindungen ansehen & widerrufen.

```
                   ┌──────────────────────── ein Host / eine Domain ───────────────────────┐
  Browser ────────►│  caddy ──► /mcp /oauth /me /.well-known… ──► mcp  ──► GraphQL ──► wiki │
  MCP-Clients ────►│        ──► alles andere ────────────────────────────────────────► wiki │
                   │                                          wiki ──► postgres (db)        │
                   └────────────────────────────────────────────────────────────────────────┘
```

## Quick-Start (Docker Compose)

```bash
cp .env.example .env     # DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET setzen
docker compose up -d
```

Lokal testen ohne Domain/TLS (alles auf `http://localhost:8090`):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

**Wiki.js selbst gehört nicht ins Repo:** Es läuft aus dem offiziellen Image
`requarks/wiki:2`, das Compose beim ersten Start automatisch zieht — hier liegt
nur der MCP-Server, die Deploy-Konfiguration und eine gemountete Wiki-Config
([deploy/wiki/config.yml](deploy/wiki/config.yml), unverändert bis auf den
DB-Pool). Updates: neues Image ziehen, fertig.

## Ersteinrichtung (erster Admin, Startseite, Suche)

Ein frisches Wiki.js startet im Setup-Modus (Admin-Konto anlegen, Startseite
fehlt). Das Bootstrap-Skript erledigt alles in einem Rutsch — **idempotent**,
kann jederzeit erneut laufen (Node ≥ 18 auf dem Host):

```bash
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='sicheres-passwort' \
  node deploy/scripts/bootstrap.mjs --locale=de
# Windows PowerShell:
#   $env:ADMIN_EMAIL='admin@example.org'; $env:ADMIN_PASSWORD='...'
#   node deploy\scripts\bootstrap.mjs --locale=de
```

`--demo` legt zusätzlich eine Gruppe „Team" + Testnutzer an und **verlangt
dann `DEMO_PASSWORD`** (kein Default, sonst entstünde ein Konto mit öffentlich
bekanntem Passwort). Nur für Test-Instanzen, nicht auf Produktiv-Wikis:
`… ADMIN_PASSWORD='…' DEMO_PASSWORD='…' node deploy/scripts/bootstrap.mjs --demo`.

Das legt an: Admin-Konto, Startseite, **PostgreSQL-Suchmaschine** (Wörterbuch
passend zur Sprache — deutlich bessere Agenten-Suche als der Default), mit
`--locale=de` die deutsche Oberfläche und mit `--demo` eine Gruppe „Team"
(lesen/schreiben, kein Löschen) samt Testnutzer. Bei laufendem Stack auf
anderer URL: `WIKI_URL=https://wiki.example.org` voranstellen.

Manuell ginge es auch (Browser: „Create Home Page"-Wizard, dann Administration
→ Search Engine / Locale / Groups) — Hinweis dabei: Hält der Wiki-Login im
Browser nicht (nach Login wieder abgemeldet), blockiert meist ein
Werbe-/Tracking-Blocker (z. B. Brave Shields) die Cookies der Domain.

Danach Nutzer anlegen: Administration → Groups (Gruppe mit `read:pages`,
`write:pages`, … — **ohne** `manage:system`) → Users. Mehr im
[Konzept-Dokument](mcp-for-wiki-js/docs/konzept-ki-zugang.md).

## Bestehendes Wiki.js? Nur den MCP-Server ergänzen

Läuft bei euch schon ein Wiki.js-2.x-Container, braucht ihr nur den
MCP-Server daneben (das Wiki bleibt unangetastet — kein Fork, keine Migration):

```bash
docker build -t wikijs-mcp .
docker run -d --name wikijs-mcp --restart unless-stopped \
  --network <netz-des-wiki-containers> \
  -v mcp-data:/data \
  -e WIKIJS_URL=http://<wiki-container>:3000 \
  -e PUBLIC_BASE_URL=https://wiki.example.org \
  -e MCP_SESSION_SECRET=<32-zufallsbytes> \
  -e WIKIJS_PERMISSION_PRESET=full \
  -e WIKIJS_BLOCKED_TAGS=kein-ki \
  wikijs-mcp
```

Dann im **vorhandenen** Reverse-Proxy die MCP-Pfade auf denselben Host legen
(`/mcp`, `/oauth`, `/me`, `/.well-known/oauth-*`, `/.well-known/mcp.json`,
`/_next`, `/api/health` → `wikijs-mcp:3000`, alles andere weiter zum Wiki) —
Vorlage: [deploy/caddy/Caddyfile](deploy/caddy/Caddyfile). Gleiche Domain ist
wichtig: Sie macht die OAuth-Freigabe per Wiki-Sitzung zum Ein-Klick.
Empfohlen außerdem: den Wiki-DB-Pool anheben (max 10 → 20, siehe
[deploy/wiki/config.yml](deploy/wiki/config.yml)) und die
PostgreSQL-Suchmaschine aktivieren.

| URL | Zweck |
|---|---|
| `https://<DOMAIN>` | Wiki.js (Ersteinrichtung beim ersten Start) |
| `https://<DOMAIN>/mcp` | MCP-Endpoint — die Connector-URL für alle Clients |
| `https://<DOMAIN>/me` | Eigene KI-Zugänge ansehen / widerrufen |

Clients verbinden (Beispiele):

```bash
# Claude Code
claude mcp add --transport http wiki https://<DOMAIN>/mcp   # dann: /mcp → Authenticate

# claude.ai / Claude Desktop:  Settings → Connectors → Add custom connector → URL
# ChatGPT / Codex:             Connector mit der URL anlegen → OAuth-Login startet automatisch
```

**Update:** `docker compose pull && docker compose build --pull mcp && docker compose up -d` —
Wiki.js läuft aus dem offiziellen Image und bleibt unabhängig updatebar.

## Repo-Layout

| Pfad | Inhalt |
|---|---|
| [`mcp-for-wiki-js/`](mcp-for-wiki-js/) | Der MCP-Server (Next.js/TypeScript): 70 Tools über die Wiki.js-GraphQL-API, OAuth-Layer, Rechte-Engine, Tests. Details: [README](mcp-for-wiki-js/README.md) · [Konzept & Rechtemodell (deutsch)](mcp-for-wiki-js/docs/konzept-ki-zugang.md) · [OAuth-Doku](mcp-for-wiki-js/docs/oauth.md) |
| [`Dockerfile`](Dockerfile) | Production-Image des MCP-Servers (Next.js standalone, Node 24) |
| [`docker-compose.yml`](docker-compose.yml) | Komplett-Stack: Postgres + Wiki.js + MCP + Caddy (Auto-HTTPS) |
| [`deploy/caddy/`](deploy/caddy/) | Reverse-Proxy-Routing (eine Domain für Wiki & MCP → Ein-Klick-SSO) |
| [`deploy/helm/wikijs-mcp/`](deploy/helm/wikijs-mcp/) | Helm-Chart für Kubernetes (MCP-Server; Wiki.js läuft separat) |
| [`.github/workflows/`](.github/workflows/) | GitHub-CI: Typecheck/Tests/Build + Image → ghcr.io |
| [`.gitlab-ci.yml`](.gitlab-ci.yml) | GitLab-CI: gleiche Checks + Image → Firmen-Registry + Helm-Chart-Push |

Nicht Teil des Repos (per `.gitignore` ausgeschlossen): `wiki/` (Referenz-Clone
von requarks/wiki) und `mcp2/` (Community-MCP-Server zum Vergleich).

## Rechte & Sperren — wer erzwingt was?

| Schicht | Wo gepflegt | Wirkung |
|---|---|---|
| Zugriffsrechte | **Wiki.js** (Gruppen, Page-Rules — pro Person) | hart, serverseitig; gilt auch für KI-Sessions |
| Bereichs-Sperre | Wiki.js: pfadbasierte **deny-Page-Rule** (z. B. `/intern/*`) | zuverlässig inkl. Suche |
| Tag-Sperre | Tag `kein-ki` auf der Seite (+ `WIKIJS_BLOCKED_TAGS`) | MCP filtert Lesen/Suche und verweigert Schreiben/Löschen |
| Agenten-Schutz | MCP-Rolle `wiki` (Default für OAuth-Sessions) | destruktive/Admin-Aktionen erst nach `confirm:true` (Dry-Run) |

Wichtig: KI-Zugängen in Wiki.js **nie** `manage:system` geben — das umgeht dort
alle Page-Rules. Und im Wiki keine Seiten unter `me/`, `oauth/`, `mcp`,
`api/` anlegen (Pfade gehören dem MCP-Server, siehe Caddy/Ingress-Routing).

## Kubernetes / GitLab

Das [Helm-Chart](deploy/helm/wikijs-mcp/README.md) deployt nur den MCP-Server
(StatefulSet + kleine PVC für den Session-Store); Wiki.js läuft als eigenes
Deployment und wird über `config.wikijs.url` angebunden. Die GitLab-Pipeline
baut das Image (`$DOCKER_REGISTRY/projects/wlo/wikijs-mcp`) und paketiert das
Chart — benötigte CI/CD-Variablen stehen im Kopf der
[.gitlab-ci.yml](.gitlab-ci.yml). Beide Pipelines bleiben grün, solange die
Registry-Variablen fehlen (Jobs werden übersprungen).

## Veröffentlichen (GitHub / GitLab)

Der Baum ist publish-fertig vorbereitet: [.gitignore](.gitignore) schließt
Secrets (`.env`), `node_modules/`, Build-Artefakte, Referenz-Ordner
(`wiki/`, `mcp2/`) und persönliche Tooling-Config aus;
[.gitattributes](.gitattributes) normalisiert Zeilenenden auf LF (wichtig, weil
Container-Skripte in Linux laufen). Kurz gegenchecken, dass keine Secrets
mitgehen: `git status` nach `git add .` darf **keine** `.env` zeigen.

`mcp-for-wiki-js/` trägt eine **eigene Git-Historie** (eingebettetes Repo) —
das ist die einzige topologie-relevante Entscheidung:

**Option A — ein Repo (empfohlen, am einfachsten für CI/Helm):**
```bash
rm -rf mcp-for-wiki-js/.git      # App-Historie verwerfen …
# … ODER vorher übernehmen: git -C mcp-for-wiki-js log bleibt via `git subtree`/`git filter-repo` importierbar
git init && git add . && git commit -m "chore: initial import"
git remote add origin <deine-repo-url> && git push -u origin main
```

**Option B — zwei Repos + Submodule (nur bei getrennten Release-Zyklen):**
```bash
# mcp-for-wiki-js zuerst als eigenes Repo pushen (behält seine Historie), dann:
git init
git submodule add <mcp-repo-url> mcp-for-wiki-js
git add . && git commit -m "chore: root deployment repo + mcp submodule"
```

Beide Topologien lassen `mcp-for-wiki-js/` am selben relativen Pfad — die
CI-Pipelines ([.gitlab-ci.yml](.gitlab-ci.yml), [.github/](.github/)) und der
[Dockerfile](Dockerfile)-Build-Context (`context: .`, kopiert `mcp-for-wiki-js/`)
funktionieren unverändert. GitLab-Helm-Push braucht die CI/CD-Variablen aus dem
Kopf der `.gitlab-ci.yml`.

## Lizenz

MIT — siehe [mcp-for-wiki-js/LICENSE](mcp-for-wiki-js/LICENSE).
