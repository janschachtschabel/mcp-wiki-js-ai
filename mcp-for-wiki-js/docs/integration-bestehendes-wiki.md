# MCP-Server in ein bestehendes Wiki.js integrieren

Kurzanleitung, um den MCP-Server neben eine **laufende** Wiki.js-2.x-Installation
(Container) zu hängen — **ohne das Wiki zu verändern** (kein Fork, keine
Migration). Für einen kompletten Neuaufbau siehe stattdessen den Compose-Stack
im [Root-README](../../README.md).

## Voraussetzungen
- Laufender **Wiki.js 2.x** (Container) mit Postgres.
- Ein Reverse-Proxy vor dem Wiki auf **einer Domain** (nginx / Traefik / Caddy).
- Docker-Zugriff auf demselben Host (oder ein fertiges Image aus eurer Registry).

## Schritte

### 1. Image bauen (oder ziehen)
Im Repo-Root:
```bash
docker build -t wikijs-mcp .
```
(oder das CI-gebaute Image aus GHCR/eurer Registry ziehen.)

### 2. Secret erzeugen
```bash
openssl rand -base64 32          # für MCP_SESSION_SECRET
```

### 3. MCP-Container ins selbe Docker-Netz starten
```bash
docker run -d --name wikijs-mcp --restart unless-stopped \
  --network <netz-des-wiki-containers> \
  -v mcp-data:/data \
  -e WIKIJS_URL=http://<wiki-container>:3000 \
  -e PUBLIC_BASE_URL=https://<eure-domain> \
  -e MCP_SESSION_SECRET=<secret-aus-schritt-2> \
  -e WIKIJS_PERMISSION_PRESET=full \
  -e WIKIJS_BLOCKED_TAGS=kein-ki \
  wikijs-mcp
```

| Env | Zweck |
|---|---|
| `WIKIJS_URL` | interne Adresse des Wiki-Containers (über das Docker-Netz, kein externer Traffic) |
| `PUBLIC_BASE_URL` | **öffentliche** Basis-URL (OAuth-Issuer) — muss zur Domain passen; hinter Proxy Pflicht |
| `MCP_SESSION_SECRET` | schaltet OAuth ein; verschlüsselt den Session-Store in `/data` |
| `WIKIJS_PERMISSION_PRESET` | im OAuth-Betrieb `full` lassen — die echten Rechte kommen aus Wiki.js |
| `WIKIJS_BLOCKED_TAGS` | Seiten mit diesem Tag sind für KI unsichtbar/unantastbar (leer = aus) |

Der `-v mcp-data:/data`-Mount persistiert die KI-Sessions über Neustarts.

### 4. Reverse-Proxy: MCP-Pfade auf dieselbe Domain
Im **vorhandenen** Proxy diese Pfade zu `wikijs-mcp:3000` routen, **alles andere**
weiter zum Wiki:
```
/mcp   /oauth   /me   /_next   /api/health
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
/.well-known/mcp.json
```
Vorlage (Caddy): [deploy/caddy/Caddyfile](../../deploy/caddy/Caddyfile).
**Gleiche Domain wie das Wiki ist wichtig** — nur dann macht die bestehende
Wiki-Sitzung die OAuth-Freigabe zum Ein-Klick (SSO).

### 5. Wiki.js-seitig vorbereiten
- **Gruppe „Team"** anlegen (Administration → Groups) mit `read:pages`,
  `write:pages`, `read:assets`, `write:assets`, `read:comments`,
  `write:comments`, `read:source`, `read:history` — **ohne** `manage:system`
  (das würde alle Page-Rules aushebeln). Nutzer zuordnen.
- **Empfohlen:** DB-Pool von 10 → 20 anheben (siehe
  [deploy/wiki/config.yml](../../deploy/wiki/config.yml)) und die
  **PostgreSQL-Suchmaschine** aktivieren (Administration → Search Engine →
  PostgreSQL, Wörterbuch passend zur Sprache) — deutlich bessere Agenten-Suche.

### 6. Testen
```bash
curl https://<eure-domain>/.well-known/oauth-authorization-server   # muss JSON liefern
curl https://<eure-domain>/api/health                               # {"ok":true}
```
Dann einen Client verbinden:
```bash
claude mcp add --transport http wiki https://<eure-domain>/mcp      # dann /mcp → Authenticate
```
Der Browser öffnet die Wiki-Freigabe — bei bestehender Wiki-Sitzung ein Klick.

## Grenzen & Troubleshooting
- **Login öffnet ein Formular statt Ein-Klick?** Wiki und MCP laufen nicht auf
  **derselben** Domain — der Wiki-Cookie greift dann nicht. Domain/Proxy prüfen.
- **Keine Wiki-Seiten** unter `me/`, `oauth/`, `mcp`, `api/` anlegen — diese
  Pfade gehören dem MCP-Server.
- KI-Zugängen **nie** `manage:system` geben (umgeht alle Page-Rules).
- Vertiefung: [Konzept & Rechtemodell](./konzept-ki-zugang.md) ·
  [OAuth-Technik & Grenzen](./oauth.md).

## Nutzung (für Endnutzer)

Ist alles eingerichtet, tragen die Team-Mitglieder im KI-Programm (Claude Code,
claude.ai, ChatGPT/Codex, Cursor) einfach die **eine URL** ein:

```
https://<eure-domain>/mcp
```

Beim ersten Verbinden führt der Client einmalig durch den Wiki-Login (ein Klick,
wenn man im Wiki schon angemeldet ist) — danach arbeitet der KI-Assistent mit
den **eigenen Wiki-Rechten**, ohne dass das Wiki geöffnet sein muss.

Die eigenen KI-Verbindungen ansehen und jederzeit widerrufen kann jede Person
unter:

```
https://<eure-domain>/me
```

