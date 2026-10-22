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

![Architektur: KI-Clients und Browser → Caddy (eine Domain) → MCP-Server (OAuth, Policy-Gate, Tools, GraphQL-Client) → Wiki.js → PostgreSQL im internen Netz](mcp-for-wiki-js/docs/architektur.png)

Interaktive Fassung mit Quellenverweisen je Komponente: [docs/architektur.html](mcp-for-wiki-js/docs/architektur.html)
(lokal im Browser öffnen; Quelle zum Weiterbearbeiten mit archify: [architektur.archify.json](mcp-for-wiki-js/docs/architektur.archify.json)).

> **Für die IT:** kompakte Anleitung für alle Wege (bestehendes Wiki per Helm/Kubernetes, bestehendes
> Wiki auf einem Server mit Docker, Neuinstallation per Docker Compose): [installation-it.md](mcp-for-wiki-js/docs/installation-it.md).

## Quick-Start: welche Compose-Datei?

| Situation | Datei | HTTPS über |
|---|---|---|
| Docker-Panel mit Import aus GitHub (z. B. Hostinger Docker Manager), Traefik läuft schon | [`docker-compose.yml`](docker-compose.yml) (Hauptordner) | vorhandenen Traefik |
| Eigener Server ohne Reverse-Proxy, ohne Repo-Checkout | [`deploy/standalone/full/docker-compose.yml`](deploy/standalone/full/docker-compose.yml) | eigenen Caddy (Ports 80/443) |
| Wiki.js läuft schon, nur der MCP kommt dazu | [`deploy/standalone/mcp-only/docker-compose.yml`](deploy/standalone/mcp-only/docker-compose.yml) | vorhandenen Proxy |
| Image selbst bauen / entwickeln (Repo-Checkout) | [`docker-compose.build.yml`](docker-compose.build.yml) | eigenen Caddy (Ports 80/443) |

Die ersten beiden nutzen das fertige Image aus GHCR, brauchen **keine Pflicht-Variablen** und erzeugen
Postgres-Passwort und `MCP_SESSION_SECRET` beim ersten Start selbst (Volume `stack-secrets`, gehört
zur Datensicherung). Die Ersteinrichtung (Admin-Konto, Startseite, `/ki-zugang`, Suche, Sprache) läuft
dort automatisch, sobald `DOMAIN`, `ADMIN_EMAIL` und `ADMIN_PASSWORD` gesetzt sind.

### Docker-Panel mit Traefik (z. B. Hostinger Docker Manager)

Solche Panels lesen nur die `docker-compose.yml` im Hauptordner und kopieren `.env.example` als `.env`.
Variablen lassen sich erst bearbeiten, wenn das Projekt existiert — daher zwei Schritte:

1. **Compose from URL** mit `https://github.com/janschachtschabel/mcp-wiki-js-ai`, ohne Variablen
   bereitstellen.
2. Projekt bearbeiten, in der `.env` setzen und neu bereitstellen:

| Variable | Wert |
|---|---|
| `DOMAIN` | nur der Hostname, z. B. `wiki.example.org` (DNS-A-Eintrag zeigt auf den Server) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | erstes Admin-Konto; `ADMIN_PASSWORD` nach der Einrichtung wieder leeren |
| `BOOTSTRAP_ARGS` | optional, z. B. `--locale=en` (Deutsch ist voreingestellt) oder `--demo` |

Traefik routet die MCP-Pfade an den MCP-Server, alles andere an Wiki.js, und sperrt den Setup-Endpunkt
`/finalize`. Die Datei setzt kein vorhandenes Docker-Netz voraus: Sie legt ihr eigenes Netz
`wikijs-web` an, das ein Traefik im Host-Modus (wie bei Hostinger) direkt erreicht. Entrypoint
`websecure` und Zertifikats-Resolver `letsencrypt` passen zu Hostingers Traefik; bei anderem Traefik
`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER` und — läuft Traefik in einem eigenen Docker-Netz —
`TRAEFIK_NETWORK` (Name dieses Netzes) setzen. Ergebnis der Einrichtung: Log des Containers
`bootstrap`. Danach in Wiki.js die Gruppe „Team“ ohne `manage:system` anlegen; Anwender verbinden
sich mit `https://<DOMAIN>/mcp`.

### Eigener Server ohne Proxy (eine Datei, kein Repo)

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```

Ports 80/443 müssen frei sein (Caddy holt das Zertifikat). Ohne `DOMAIN` zeigt die Seite „noch nicht
eingerichtet“. In Docker-Panels ohne Traefik geht auch der GitHub-Link auf diese Datei bzw.
Repository + Pfad `deploy/standalone/full`.

### Selbst bauen (Repo-Checkout)

```bash
cp .env.example .env     # COMPOSE_FILE=docker-compose.build.yml, DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d     # baut das MCP-Image, Caddy holt TLS
```

Mit `COMPOSE_FILE` in der `.env` gelten alle `docker compose …`-Befehle ohne `-f`. Ohne `DOMAIN` (oder
ohne `MCP_SESSION_SECRET`) bricht `docker compose` mit einer klaren Meldung ab. Lokal testen ohne
Domain/TLS (alles auf `http://localhost:8090`):

```bash
docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d
```

**Wiki.js selbst gehört nicht ins Repo:** Es läuft aus dem offiziellen Image
`requarks/wiki:2`, das Compose beim ersten Start automatisch zieht — hier liegt
nur der MCP-Server, die Deploy-Konfiguration und (für `docker-compose.build.yml`)
eine gemountete Wiki-Config ([deploy/wiki/config.yml](deploy/wiki/config.yml),
unverändert bis auf den DB-Pool). Updates: neues Image ziehen, fertig.

## Ersteinrichtung (erster Admin, Startseite, Suche)

Bei `docker-compose.yml` und `deploy/standalone/full` läuft die Ersteinrichtung automatisch (siehe
oben). Mit `docker-compose.build.yml` startet ein frisches Wiki.js im Setup-Modus (Admin-Konto
anlegen, Startseite fehlt); der Compose-Dienst `bootstrap` erledigt alles in einem Rutsch —
**idempotent**, kann jederzeit erneut laufen (kein Node auf dem Host nötig):

```bash
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='sicheres-passwort' \
  docker compose run --rm bootstrap --locale=de
# Lokaler Test-Stack: dieselben -f-Angaben wie beim Start
#   docker compose -f docker-compose.build.yml -f docker-compose.local.yml run --rm bootstrap --locale=de
# Windows PowerShell:
#   $env:ADMIN_EMAIL='admin@example.org'; $env:ADMIN_PASSWORD='...'
#   docker compose run --rm bootstrap --locale=de
```

**Warum nicht im Browser?** Bis zur Einrichtung legt bei Wiki.js der erste
Aufruf von `/finalize` das Admin-Konto an — für jeden, der die Domain erreicht.
Caddy bzw. Traefik sperren `/finalize` deshalb von außen; der Dienst `bootstrap`
spricht im internen Docker-Netz direkt mit Wiki.js. Die Adresse auf `/ki-zugang`
kommt aus `PUBLIC_BASE_URL` bzw. `https://<DOMAIN>` (lokal `http://localhost:8090`).

`--demo` legt zusätzlich eine Gruppe „Team" + Testnutzer an und **verlangt
dann `DEMO_PASSWORD`** (kein Default, sonst entstünde ein Konto mit öffentlich
bekanntem Passwort). Nur für Test-Instanzen, nicht auf Produktiv-Wikis:
`… ADMIN_PASSWORD='…' DEMO_PASSWORD='…' docker compose run --rm bootstrap --demo`.
Optional: `DEMO_EMAIL` (Default `test@team.local`) und `DEMO_NAME` (Default `Test-Zugang`).

Das legt an: Admin-Konto, Startseite, die Anwender-Anleitung **`/ki-zugang`**
(Connector-Adresse + Einrichtung pro KI-Programm), **PostgreSQL-Suchmaschine** (Wörterbuch
passend zur Sprache — deutlich bessere Agenten-Suche als der Default), mit
`--locale=de` die deutsche Oberfläche und mit `--demo` eine Gruppe „Team"
(lesen/schreiben, kein Löschen) samt Testnutzer.

Das Skript lässt sich auch direkt mit Node ≥ 18 starten
(`WIKI_URL=https://wiki.example.org … node deploy/scripts/bootstrap.mjs`; `PUBLIC_URL`
setzt dabei eine abweichende Connector-Adresse für `/ki-zugang`, Default `WIKI_URL`) — über
die Domain aber nur für ein **bereits eingerichtetes** Wiki (etwa um `--locale`
oder `--demo` nachzuholen), denn `/finalize` ist dort gesperrt.

Die Schritte nach dem Admin-Konto gingen auch manuell (Browser: „Create Home Page"-Wizard, dann Administration
→ Search Engine / Locale / Groups) — Hinweis dabei: Hält der Wiki-Login im
Browser nicht (nach Login wieder abgemeldet), blockiert meist ein
Werbe-/Tracking-Blocker (z. B. Brave Shields) die Cookies der Domain.

Danach Nutzer anlegen: Administration → Groups (Gruppe mit `read:pages`,
`write:pages`, … — **ohne** `manage:system`) → Users. Mehr im
[Konzept-Dokument](mcp-for-wiki-js/docs/konzept-ki-zugang.md).

## Bestehendes Wiki.js? Nur den MCP-Server ergänzen

Läuft bei euch schon ein Wiki.js-2.x-Container, braucht ihr nur den MCP-Server
daneben (das Wiki bleibt unangetastet — kein Fork, keine Migration): Image
bauen → Container ins selbe Docker-Netz (`WIKIJS_URL=http://<wiki>:3000` +
`MCP_SESSION_SECRET` + `PUBLIC_BASE_URL`) → im **vorhandenen** Reverse-Proxy die
MCP-Pfade auf dieselbe Domain legen → in Wiki.js eine „Team"-Gruppe (ohne
`manage:system`) anlegen.

**→ Schritt-für-Schritt-Anleitung: [docs/integration-bestehendes-wiki.md](mcp-for-wiki-js/docs/integration-bestehendes-wiki.md).**
Läuft das Wiki auf einem vServer mit eigenem Proxy: fertige Compose-Datei
[`deploy/standalone/mcp-only/docker-compose.yml`](deploy/standalone/mcp-only/docker-compose.yml) plus
nginx-/Caddy-Beispiele in der [IT-Anleitung, Option B](mcp-for-wiki-js/docs/installation-it.md#option-b-bestehendes-wikijs-auf-einem-server-mit-docker-vserver).

| URL | Zweck |
|---|---|
| `https://<DOMAIN>` | Wiki.js |
| `https://<DOMAIN>/mcp` | MCP-Endpoint — die Connector-URL für alle Clients |
| `https://<DOMAIN>/me` | Eigene KI-Zugänge ansehen / widerrufen |

Clients verbinden (Beispiele):

```bash
# Claude Code
claude mcp add --transport http wiki https://<DOMAIN>/mcp   # dann: /mcp → Authenticate

# claude.ai / Claude Desktop:  Settings → Connectors → Add custom connector → URL
# ChatGPT / Codex:             Connector mit der URL anlegen → OAuth-Login startet automatisch
```

**Update:** `docker compose pull && docker compose up -d` (Docker-Panel: neu bereitstellen; mit
`docker-compose.build.yml` zusätzlich `docker compose build --pull mcp`) — Wiki.js läuft aus dem
offiziellen Image und bleibt unabhängig updatebar.

## Repo-Layout

| Pfad | Inhalt |
|---|---|
| [`mcp-for-wiki-js/`](mcp-for-wiki-js/) | Der MCP-Server (Next.js/TypeScript): 70 Tools über die Wiki.js-GraphQL-API, OAuth-Layer, Rechte-Engine, Tests. Details: [README](mcp-for-wiki-js/README.md) · [Konzept & Rechtemodell (deutsch)](mcp-for-wiki-js/docs/konzept-ki-zugang.md) · [OAuth-Doku](mcp-for-wiki-js/docs/oauth.md) |
| [`Dockerfile`](Dockerfile) | Production-Image des MCP-Servers (Next.js standalone, Node 24) |
| [`docker-compose.yml`](docker-compose.yml) | Komplett-Stack hinter vorhandenem Traefik (Docker-Panels): Postgres + Wiki.js + MCP + Backup, fertiges Image, Geheimnisse automatisch |
| [`deploy/standalone/`](deploy/standalone/) | Ohne Repo-Checkout: `full/` Komplett-Stack mit eigenem Caddy (80/443), `mcp-only/` nur MCP neben bestehendem Wiki |
| [`docker-compose.build.yml`](docker-compose.build.yml) | Komplett-Stack zum Selbstbauen: Postgres + Wiki.js + MCP (lokaler Build) + Caddy (Auto-HTTPS) + Backup; `docker-compose.local.yml` für lokale Tests |
| [`deploy/scripts/`](deploy/scripts/) | `bootstrap.mjs` (Ersteinrichtung), `standalone-init.mjs` (Geheimnisse, Caddyfile) — beide auch im Image |
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
| Tag-Sperre | Tag `kein-ki` auf der Seite (+ `WIKIJS_BLOCKED_TAGS`) | MCP filtert Lesen/Suche/Baum/Links und verweigert Schreiben/Löschen; Ausnahme: Kommentare, die nur per Kommentar-ID angesprochen werden |
| Agenten-Schutz | MCP-Rolle `wiki` (Default für OAuth-Sessions) | destruktive/Admin-Aktionen erst nach `confirm:true` (Dry-Run) — eine Bremse gegen Versehen, **keine** menschliche Freigabe: das Modell setzt `confirm` selbst |

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

## Repository & Veröffentlichen

Das Projekt liegt als **ein** Repo auf GitHub:
[github.com/janschachtschabel/mcp-wiki-js-ai](https://github.com/janschachtschabel/mcp-wiki-js-ai).
`mcp-for-wiki-js/` ist darin ein normaler Ordner (keine eigene Historie, kein Submodule).
[.gitignore](.gitignore) schließt Secrets (`.env`), `node_modules/`,
Build-Artefakte und die Referenz-Ordner (`wiki/`, `mcp2/`) aus;
[.gitattributes](.gitattributes) normalisiert Zeilenenden auf LF (Container-Skripte
laufen unter Linux). Vor jedem Commit gilt: `git status` darf **keine** `.env` zeigen.

Ein Push nach `main` baut über [.github/workflows/](.github/workflows/) das Image
`ghcr.io/janschachtschabel/mcp-wiki-js-ai`. Für ein firmeninternes GitLab dasselbe
Repo spiegeln: [.gitlab-ci.yml](.gitlab-ci.yml) baut Image und Helm-Chart, sobald die
CI/CD-Variablen aus ihrem Kopf gesetzt sind.

## Lizenz

Apache License 2.0 — siehe [LICENSE](LICENSE).
