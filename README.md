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

![Architektur: KI-Clients und Browser → Reverse-Proxy (eine Domain) → MCP-Server (OAuth, Policy-Gate, Tools, GraphQL-Client) → Wiki.js → PostgreSQL im internen Netz](mcp-for-wiki-js/docs/architektur.png)

Interaktive Fassung mit Quellenverweisen je Komponente: [docs/architektur.html](mcp-for-wiki-js/docs/architektur.html)
(lokal im Browser öffnen; Quelle zum Weiterbearbeiten mit archify: [architektur.archify.json](mcp-for-wiki-js/docs/architektur.archify.json)).

## Installation: welcher Fall?

| Fall | Ausgangslage | Weg | Datei |
|---|---|---|---|
| **A: Komplett** | noch kein Wiki | **A1** Docker-Panel des Hosters (Import aus dem Git-Repo, Traefik läuft schon) | [`docker-compose.yml`](docker-compose.yml) |
| | | **A2** eigener Server ohne Reverse-Proxy | [`deploy/standalone/full/`](deploy/standalone/full/docker-compose.yml) |
| | | **A3** selbst bauen (Repo-Checkout) | [`docker-compose.build.yml`](docker-compose.build.yml) |
| **B: MCP zum bestehenden Wiki** | Wiki.js läuft schon; MCP unter **derselben Adresse** | **B1** vor dem Wiki steht Traefik | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) + `TRAEFIK_ENABLE=true` |
| | | **B2** vor dem Wiki steht nginx, Caddy, Apache … | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) + Pfad-Regeln |
| | | **B3** Kubernetes | [Helm-Chart](deploy/helm/wikijs-mcp/README.md) |
| **C: Nur MCP** | Wiki läuft woanders, Proxy der Wiki-Domain nicht änderbar | **C1** MCP unter eigener Adresse | [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/docker-compose.yml) |
| | | **C2** lokal auf dem eigenen Rechner (stdio) | [Server-README](mcp-for-wiki-js/README.md#claude-desktop-lokal-stdio) |

Alle Compose-Dateien außer A3 nutzen das fertige Image `ghcr.io/janschachtschabel/mcp-wiki-js-ai:main`,
brauchen **keine Pflicht-Variablen** und erzeugen Datenbank-Passwort und `MCP_SESSION_SECRET` beim
ersten Start selbst (Volume `stack-secrets`). **Ausführliche Anleitung mit allen Varianten,
Proxy-Beispielen und Variablen: [docs/installation-it.md](mcp-for-wiki-js/docs/installation-it.md).**

### A1: Docker-Panel mit Traefik

Für Panels, die ein Projekt direkt aus dem Git-Repository bauen. Sie lesen nur die
`docker-compose.yml` im Hauptordner, kopieren `.env.example` als `.env` und erlauben Variablen erst
nach der ersten erfolgreichen Bereitstellung. Auf dem Server läuft ihr Traefik auf 80/443.

1. *Compose from URL* (o. ä.) mit `https://github.com/janschachtschabel/mcp-wiki-js-ai` — ohne
   Variablen bereitstellen.
2. Projekt bearbeiten, in der `.env` `DOMAIN` (nur Hostname, kein `https://`), `ADMIN_EMAIL` und
   `ADMIN_PASSWORD` setzen, neu bereitstellen. Die Ersteinrichtung läuft automatisch.
3. `ADMIN_PASSWORD` wieder leeren, neu bereitstellen; im Wiki eine Gruppe „Team“ ohne
   `manage:system` anlegen.

### A2: Eigener Server ohne Proxy

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```
Ein mitgelieferter Caddy belegt 80/443 und holt das Zertifikat.

### A3: Selbst bauen

```bash
cp .env.example .env     # COMPOSE_FILE=docker-compose.build.yml, DOMAIN, POSTGRES_PASSWORD, MCP_SESSION_SECRET
docker compose up -d
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' docker compose run --rm bootstrap --locale=de
```
Lokal ohne Domain: `docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d`
(`http://localhost:8090`).

### B: MCP zum bestehenden Wiki.js

```bash
mkdir wikijs-mcp && cd wikijs-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/mcp-only/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nWIKIJS_URL=https://wiki.example.org\n' > .env
docker compose up -d
```
Dann entweder **B1** `TRAEFIK_ENABLE=true` ergänzen (Traefik routet die MCP-Pfade per Label) oder
**B2** im vorhandenen Proxy die MCP-Pfade an `127.0.0.1:3100` geben — Beispiele für nginx, Caddy und
Apache in der [Anleitung](mcp-for-wiki-js/docs/installation-it.md#b2-vor-dem-wiki-steht-nginx-caddy-apache-o-ä).
Kubernetes (**B3**): [Helm-Chart](deploy/helm/wikijs-mcp/README.md).

### C: Nur MCP

**C1:** dieselbe Datei wie bei B mit eigener Adresse (`DOMAIN=mcp.example.org`,
`WIKIJS_URL=https://wiki.example.org`) und einem Proxy mit TLS davor. Anwender tragen
`https://mcp.example.org/mcp` ein; die Freigabe fragt die Wiki-Zugangsdaten dann per Formular ab.
**C2:** eine Person startet den Server lokal über stdio mit eigenem Wiki.js-API-Key —
[Server-README](mcp-for-wiki-js/README.md#claude-desktop-lokal-stdio).

## Wichtigste Umgebungsvariablen

| Variable | Bedeutung | Gilt für |
|---|---|---|
| `DOMAIN` | Hostname von Wiki/MCP, **ohne** `https://` | alle Compose-Dateien |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | erstes Admin-Konto (danach Passwort leeren) | A |
| `BOOTSTRAP_ARGS` | `--locale=en` (statt Deutsch), `--demo` (Testgruppe + Testnutzer) | A1, A2 |
| `WIKIJS_URL` | wie der MCP das vorhandene Wiki erreicht | B, C1 |
| `TRAEFIK_ENABLE` | Traefik-Labels einschalten | B1, C1 |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` / `TRAEFIK_NETWORK` | Namen im vorhandenen Traefik (Defaults `websecure` / `letsencrypt` / eigenes Netz) | A1, B1, C1 |
| `WIKIJS_BLOCKED_TAGS` | Tags, die Seiten für die KI sperren (Default `kein-ki`) | alle |
| `MCP_ALLOWED_REDIRECT_HOSTS` | erlaubte OAuth-Rückleitungen, z. B. `claude.ai,chatgpt.com` | alle |
| `MCP_IMAGE` | anderes Image oder Release-Tag | alle |

Vollständige Tabellen je Datei: [Anleitung, Umgebungsvariablen](mcp-for-wiki-js/docs/installation-it.md#umgebungsvariablen) ·
alle Server-Variablen: [Server-README](mcp-for-wiki-js/README.md#vollständige-env-referenz) ·
kommentierte Vorlage: [`.env.example`](.env.example).

## Nutzung

| URL | Zweck |
|---|---|
| `https://<DOMAIN>` | Wiki.js |
| `https://<DOMAIN>/mcp` | MCP-Endpoint — die Connector-URL für alle Clients |
| `https://<DOMAIN>/me` | eigene KI-Zugänge ansehen / widerrufen |
| `https://<DOMAIN>/ki-zugang` | Anleitung für Anwender (legt die Ersteinrichtung an) |

```bash
# Claude Code
claude mcp add --transport http wiki https://<DOMAIN>/mcp   # dann: /mcp → Authenticate

# claude.ai / Claude Desktop:  Einstellungen → Connectors → Add custom connector → URL
# ChatGPT / Cursor u. a.:      MCP-Server bzw. Connector mit der URL anlegen → Wiki-Login startet automatisch
```

## Betrieb

- **Update:** `docker compose pull && docker compose up -d` bzw. im Panel neu bereitstellen
  (A3 zusätzlich `docker compose build --pull mcp`). Wiki.js läuft aus dem offiziellen Image
  `requarks/wiki:2` und bleibt unabhängig updatebar.
- **Backup:** Fall A sichert täglich Postgres und MCP-SQLite ins Volume `db-backups` — off-host
  kopieren. Zusätzlich die Volumes `stack-secrets` und `mcp-data` sichern.
- **Ersteinrichtung** (`deploy/scripts/bootstrap.mjs`, idempotent): legt Admin-Konto, Startseite,
  `/ki-zugang`, PostgreSQL-Suche und Sprache an. Der Setup-Assistent von Wiki.js (`/finalize`) ist von
  außen gesperrt, damit niemand vor der Einrichtung das erste Admin-Konto übernimmt.

## Repo-Layout

| Pfad | Inhalt |
|---|---|
| [`mcp-for-wiki-js/`](mcp-for-wiki-js/) | Der MCP-Server (Next.js/TypeScript): 70 Tools über die Wiki.js-GraphQL-API, OAuth-Layer, Rechte-Engine, Tests. Details: [README](mcp-for-wiki-js/README.md) · [Konzept & Rechtemodell](mcp-for-wiki-js/docs/konzept-ki-zugang.md) · [OAuth-Doku](mcp-for-wiki-js/docs/oauth.md) |
| [`docker-compose.yml`](docker-compose.yml) | A1: Komplett-Stack hinter vorhandenem Traefik (Docker-Panels) |
| [`deploy/standalone/full/`](deploy/standalone/full/) | A2: Komplett-Stack mit eigenem Caddy (80/443) |
| [`deploy/standalone/mcp-only/`](deploy/standalone/mcp-only/) | B1/B2/C1: nur der MCP-Server, optional mit Traefik-Labels |
| [`docker-compose.build.yml`](docker-compose.build.yml) | A3: Komplett-Stack zum Selbstbauen; `docker-compose.local.yml` für lokale Tests |
| [`deploy/helm/wikijs-mcp/`](deploy/helm/wikijs-mcp/) | B3: Helm-Chart für Kubernetes |
| [`deploy/scripts/`](deploy/scripts/) | `bootstrap.mjs` (Ersteinrichtung), `standalone-init.mjs` (Geheimnisse, Caddyfile) — beide auch im Image |
| [`deploy/caddy/`](deploy/caddy/), [`deploy/wiki/`](deploy/wiki/) | Caddy-Routing (eine Domain für Wiki & MCP), Wiki.js-Konfiguration für A3 |
| [`Dockerfile`](Dockerfile) | Production-Image des MCP-Servers (Next.js standalone, Node 24) |
| [`.github/workflows/`](.github/workflows/), [`.gitlab-ci.yml`](.gitlab-ci.yml) | CI: Typecheck/Tests/Build + Image → ghcr.io bzw. Firmen-Registry + Helm-Chart |

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
`api/` anlegen (diese Pfade gehören dem MCP-Server).

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
