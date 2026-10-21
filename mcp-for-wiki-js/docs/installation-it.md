# Installation – Kurzanleitung für die IT

Drei Wege, den MCP-Server für Wiki.js zu betreiben:

| | Option A: bestehendes Wiki (Kubernetes) | Option B: bestehendes Wiki (Server mit Docker) | Option C: Neuinstallation (Docker Compose) |
|---|---|---|---|
| Typischer Fall | Wiki.js läuft in einem Pod | Wiki.js läuft auf einem vServer, davor ein Reverse-Proxy | noch kein Wiki vorhanden |
| Wiki.js | bleibt unverändert | bleibt unverändert | wird mit aufgesetzt |
| Was wird installiert | nur der MCP-Server (eigener Pod) | nur der MCP-Server (eigener Container) | Postgres + Wiki.js + MCP + Caddy (HTTPS) + Backup |
| Dateien | Helm-Chart | **eine** Compose-Datei, kein Repo nötig | Repo-Checkout **oder eine** Compose-Datei (auch für Docker-Panels) |
| Zeitaufwand | ca. 15 Min. | ca. 15 Min. | ca. 20 Min. |

Gemeinsame Regeln für alle Optionen:

- **Wiki und MCP laufen auf derselben Domain.** Nur dann gilt die Wiki-Anmeldung auch für die
  OAuth-Freigabe (ein Klick statt zweitem Login).
- Der MCP-Server läuft als **eigener Container/Pod**, nicht im Wiki-Container.
- Im Wiki **keine Seiten** unter `me/`, `oauth/`, `mcp`, `api/` anlegen – diese Pfade gehören dem MCP-Server.
- KI-Nutzern in Wiki.js **nie `manage:system`** geben (hebelt alle Page-Rules aus).

---

## Option A: Bestehendes Wiki.js (Kubernetes / Helm)

Voraussetzungen: Wiki.js 2.x läuft im Cluster, ein Ingress (nginx) mit TLS für die Wiki-Domain,
Zugriff auf eine Container-Registry.

### 1. Image bereitstellen
Im Repo-Root bauen und pushen (oder das von der CI gebaute Image aus GHCR/GitLab nutzen).
`<registry>`, `<pfad/wikijs-mcp>` und `<vX.Y.Z>` müssen später in Schritt 3 identisch eingetragen werden:
```bash
docker build -t <registry>/<pfad/wikijs-mcp>:<vX.Y.Z> .
docker push <registry>/<pfad/wikijs-mcp>:<vX.Y.Z>
```

### 2. Secret als Kubernetes-Secret anlegen
```bash
kubectl -n <namespace> create secret generic wikijs-mcp-secret \
  --from-literal=MCP_SESSION_SECRET="$(openssl rand -base64 32)"
```
So steht das Secret weder in einer Values-Datei noch in der Helm-Historie.

### 3. Mit Helm deployen
Chart: [`deploy/helm/wikijs-mcp`](../../deploy/helm/wikijs-mcp/README.md). Vorlage kopieren und
die Platzhalter `<...>` ersetzen:
```bash
cp deploy/helm/wikijs-mcp/values-prod.example.yaml values-prod.yaml
```
Die wichtigsten Werte darin:
```yaml
global:
  image:
    registry: <registry>                              # z. B. ghcr.io
    repository: <pfad/wikijs-mcp>                     # z. B. janschachtschabel/mcp-wiki-js-ai
image:
  tag: "<vX.Y.Z>"
config:
  existingSecret: wikijs-mcp-secret                   # aus Schritt 2
  wikijs:
    url: http://<wiki-service>.<namespace>.svc:3000   # interner Service, ohne /graphql
  oauth:
    publicBaseUrl: https://wiki.example.org           # öffentliche Wiki-Domain
ingress:
  hosts: [wiki.example.org]                           # GLEICHE Domain wie das Wiki
  tls:
    - secretName: wiki-tls                            # vorhandenes Zertifikat
      hosts: [wiki.example.org]
```
```bash
helm install wikijs-mcp deploy/helm/wikijs-mcp -n <namespace> -f values-prod.yaml
```
Das Chart legt auf der Wiki-Domain nur diese Pfade für den MCP an, alles andere bleibt beim Wiki:
`/mcp`, `/oauth`, `/me`, `/_next`, `/api/health`, `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, `/.well-known/mcp.json`.

> `replicaCount` muss **1** bleiben (Sessions liegen in einer SQLite-Datei auf dem PVC).
> Ohne Helm: gleiche Env-Variablen (Tabelle unten), Port 3000, Volume auf `/data`.

### 4. In Wiki.js vorbereiten
Administration → Groups: Gruppe „Team" mit `read`/`write` auf Pages, Assets, Comments sowie
`read:source`, `read:history` – **ohne** `manage:system`. Nutzer zuordnen.
Empfohlen: Administration → Search Engine → PostgreSQL (bessere Suche für KI-Agenten).

### 5. Testen
```bash
curl https://wiki.example.org/api/health                              # {"ok":true,"store":"ok"}
curl https://wiki.example.org/.well-known/oauth-authorization-server  # JSON
```

---

## Option B: Bestehendes Wiki.js auf einem Server mit Docker (vServer)

Voraussetzungen: Wiki.js 2.x läuft (als Container oder direkt), davor ein Reverse-Proxy (nginx, Caddy,
Traefik …) mit TLS für die Wiki-Domain, Docker Compose auf dem Server. Gebraucht wird nur **eine**
Datei, [`deploy/standalone/docker-compose.mcp-only.yml`](../../deploy/standalone/docker-compose.mcp-only.yml).
Kein Repo-Checkout und kein Build nötig: Das fertige Image kommt aus GHCR.

### 1. Compose-Datei holen und Variablen setzen
```bash
mkdir wikijs-mcp && cd wikijs-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/docker-compose.mcp-only.yml
```
Daneben eine `.env`:
```
WIKIJS_URL=https://wiki.example.org
PUBLIC_BASE_URL=https://wiki.example.org
MCP_SESSION_SECRET=<openssl rand -base64 32>
# MCP_PORT=3100        lokaler Port für den Proxy (Default 3100, nur an 127.0.0.1)
```
Für `WIKIJS_URL` ist die Wiki-Domain am einfachsten. Alternativ geht `http://host.docker.internal:<port>`,
wenn Wiki.js auf dem Host nicht nur an `127.0.0.1` lauscht. Starten und prüfen:
```bash
docker compose up -d
curl http://127.0.0.1:3100/api/health        # {"ok":true,"store":"ok"}
```

### 2. Pfade im vorhandenen Reverse-Proxy an den MCP geben
Auf der Wiki-Domain gehen nur die MCP-Pfade an `127.0.0.1:3100`, alles andere bleibt beim Wiki.
Beide Beispiele sind getestet.

**nginx:** im bestehenden `server { … }`-Block der Wiki-Domain ergänzen. Die `location /` des Wikis
bleibt, Regex-Locations haben Vorrang.
```nginx
location ~ ^/(mcp(/|$)|oauth/|me(/|$)|_next/|api/health$|\.well-known/(oauth-authorization-server|oauth-protected-resource|mcp\.json)) {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # Streaming-Antworten (SSE) nicht puffern
    client_max_body_size 8m;
}
```
**Caddy:** im bestehenden Site-Block der Wiki-Domain. Der bisherige `reverse_proxy` zum Wiki wandert
in das letzte `handle`.
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
		reverse_proxy 127.0.0.1:3000   # bestehendes Wiki.js (bisheriges Ziel)
	}
}
```
Andere Proxys (Traefik, Apache, Panel-Proxys): dieselben Pfade per Pfad-Regel auf den MCP legen.
`X-Forwarded-For` muss **angehängt** werden, da die Login-Limits pro Client-IP zählen.

### 3. Wiki.js vorbereiten und testen
Wie Option A, Schritte 4 und 5.

**Update:** `docker compose pull && docker compose up -d`. Das Image-Tag `:main` folgt dem
Hauptzweig. Für feste Stände ein Release-Tag setzen (`MCP_IMAGE=ghcr.io/janschachtschabel/mcp-wiki-js-ai:<vX.Y.Z>`).
Sessions und Audit-Log liegen im Volume `mcp-data` (sichern wie unter Option C, Betrieb).

---

## Option C: Neuinstallation zusammen mit Wiki.js (Docker Compose)

Voraussetzungen: Linux-Host mit Docker Compose, Ports 80/443 frei und erreichbar, DNS-Eintrag auf den
Host. Sind 80/443 schon durch einen anderen Proxy belegt, Wiki.js wie gewohnt hinter diesen Proxy stellen
und den MCP nach Option B ergänzen.

### Variante 1: mit Repo-Checkout (Standard)
```bash
git clone https://github.com/janschachtschabel/mcp-wiki-js-ai.git && cd mcp-wiki-js-ai
cp .env.example .env
```
In `.env` setzen:
```
DOMAIN=wiki.example.org
POSTGRES_PASSWORD=<openssl rand -base64 24>
MCP_SESSION_SECRET=<openssl rand -base64 32>
```
Starten und einrichten:
```bash
docker compose up -d
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' docker compose run --rm bootstrap --locale=de
```
Der Dienst `bootstrap` (Image `node:24-alpine`, startet nicht mit `up`) spricht im internen
Docker-Netz direkt mit Wiki.js. Den Setup-Endpunkt `/finalize` beantwortet Caddy von außen immer mit
`403` — bis zur Einrichtung kann also niemand über die Domain das erste Admin-Konto anlegen (auch der
Browser-Wizard nicht). Die Connector-Adresse auf `/ki-zugang` kommt aus `PUBLIC_BASE_URL` bzw.
`https://<DOMAIN>`. Das Skript (idempotent, jederzeit wiederholbar) legt Admin-Konto, Startseite, die
Anwender-Anleitung `/ki-zugang`, PostgreSQL-Suche und deutsche Oberfläche an. Danach Gruppe „Team"
wie in Option A, Schritt 4 anlegen.

Lokal ohne Domain/TLS testen: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`
(erreichbar unter `http://localhost:8090`), Einrichtung mit denselben zwei `-f`-Angaben vor
`run --rm bootstrap`.

Direkt mit Node auf dem Host (`WIKI_URL=https://… node deploy/scripts/bootstrap.mjs`) geht nur noch
für ein **bereits eingerichtetes** Wiki (z. B. `--locale` oder `--demo` nachholen) — die Ersteinrichtung
über die Domain scheitert an der `/finalize`-Sperre.

### Variante 2: eine Datei, ohne Repo (z. B. Compose-Import in Docker-Panels)
Die Repo-Datei `docker-compose.yml` baut das MCP-Image lokal und bindet Dateien aus `deploy/` ein.
Panels, die eine Compose-Datei per URL importieren, finden diese Dateien nicht und melden
„nicht gefunden“. Dafür gibt es [`deploy/standalone/docker-compose.full.yml`](../../deploy/standalone/docker-compose.full.yml):
gleiche Dienste, fertiges Image aus GHCR, Caddy-Konfiguration in der Datei selbst, Ersteinrichtung
automatisch beim Start.

- **Docker-Panel:** als Compose-Quelle diese URL angeben und die Variablen im Panel eintragen:
  `https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/docker-compose.full.yml`
- **Server ohne Repo:** die Datei per `curl -fsSLo docker-compose.yml <URL>` holen, `.env` daneben,
  dann `docker compose up -d`.

Variablen (Pflicht: die ersten drei):
```
DOMAIN=wiki.example.org
POSTGRES_PASSWORD=<openssl rand -base64 24>
MCP_SESSION_SECRET=<openssl rand -base64 32>
ADMIN_EMAIL=admin@example.org          # nur für die Ersteinrichtung
ADMIN_PASSWORD=…                       # nach dem ersten Start wieder entfernen
# BOOTSTRAP_ARGS=--locale=de           # Default; mit --demo zusätzlich Gruppe „Team“ + Testnutzer
```
Beim Start richtet der Dienst `bootstrap` das Wiki ein (Admin-Konto, Startseite, `/ki-zugang`,
PostgreSQL-Suche, Sprache) und beendet sich dann. Das Ergebnis steht in `docker compose logs bootstrap`.
Ohne `ADMIN_EMAIL`/`ADMIN_PASSWORD` überspringt er sich. Er ist idempotent, ein erneuter Start ändert
ein eingerichtetes Wiki nicht. Unterschiede zu Variante 1: Wiki.js nutzt seinen eingebauten DB-Pool
(max. 10 Verbindungen, daher `WIKIJS_MAX_CONCURRENCY` Default `6`), und Updates brauchen keinen Build
(`docker compose pull && docker compose up -d`).

**Betrieb**

| Aufgabe | Befehl / Hinweis |
|---|---|
| Update | `docker compose pull && docker compose build --pull mcp && docker compose up -d` (Variante 2: ohne `build`) |
| Logs | `docker compose logs -f` |
| Backup | automatisch täglich (Postgres + MCP-SQLite), 7 Stück, Volume `db-backups` – **off-host replizieren** |
| Alles löschen | `docker compose down -v` (**löscht alle Daten**) |

---

## Adressen: `WIKIJS_URL` und `PUBLIC_BASE_URL`

Der MCP-Server kennt zwei Adressen — beide sind frei konfigurierbar, eine IP ist nie nötig:

| Variable | Wofür | Beispiele |
|---|---|---|
| `WIKIJS_URL` | Wie der MCP-Server das Wiki **intern** erreicht (GraphQL) | `http://wiki:3000` (Compose), `http://<service>.<namespace>.svc:3000` (Kubernetes), oder die Domain `https://wiki.example.org` |
| `PUBLIC_BASE_URL` | Unter welcher **öffentlichen** Adresse Nutzer und KI-Clients den MCP erreichen | `https://wiki.example.org` — dieselbe Domain wie das Wiki |

Liegen Wiki und MCP im selben Docker-Netz bzw. Cluster, ist die interne Adresse die robustere Wahl
(kein Umweg über Proxy und Zertifikat). Läuft das Wiki woanders, die Domain eintragen. Hat die Domain
ein **firmeninternes Zertifikat**, muss Node die Zertifizierungsstelle kennen: PEM-Datei in den
Container mounten und `NODE_EXTRA_CA_CERTS=/pfad/ca.pem` setzen (Compose: per Override-Datei mit
`volumes` + `environment`). Im Helm-Chart ist das Einhängen eigener Dateien derzeit nicht vorgesehen —
dort die interne Service-Adresse per `http://` verwenden.

## Konfiguration (Umgebungsvariablen des MCP-Servers)

| Variable | Zweck | Default (Compose/Helm) |
|---|---|---|
| `WIKIJS_URL` | interne Adresse des Wiki.js (ohne `/graphql`) | – (Pflicht) |
| `PUBLIC_BASE_URL` | öffentliche URL (OAuth-Issuer), muss zur Domain passen | – (Pflicht) |
| `MCP_SESSION_SECRET` | schaltet OAuth ein, verschlüsselt den Session-Store in `/data` (mind. 16 Zeichen) | – (Pflicht) |
| `WIKIJS_PERMISSION_PRESET` | Rechte-Ceiling; bei OAuth `full` lassen | `full` |
| `WIKIJS_BLOCKED_TAGS` | Seiten mit diesen Tags sind für KI unsichtbar (leer = aus) | `kein-ki` |
| `WIKIJS_AUDIT` | Audit-Log an/aus | `true` |
| `WIKIJS_ALLOW_LEGACY` | zusätzlich alten Zugang per API-Key/Handle erlauben (nur für Altbestand) | `false` |
| `WIKIJS_OAUTH_ROLE` | Agenten-Schutzrolle für OAuth-Sitzungen (Bestätigung vor Löschen/Admin) | `wiki` |
| `WIKIJS_MAX_CONCURRENCY` | max. parallele Anfragen an Wiki.js (unter dem DB-Pool halten) | `12` (Compose mit Repo) / `6` (Standalone-Dateien) / `8` |
| `NODE_EXTRA_CA_CERTS` | zusätzliche Zertifizierungsstelle, wenn `WIKIJS_URL` ein internes Zertifikat hat | – |
| `TZ` | Zeitzone der Zeitangaben auf `/me` | `UTC` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | optional: Hostnamen (kommagetrennt), an die OAuth-Clients weiterleiten dürfen; Loopback immer erlaubt (Helm: `config.extraEnv`; Compose: in `.env`) | – (jeder https-Host) |

Alle weiteren Variablen (Legacy-Betrieb, Limits, Diagnose): vollständige Referenz in der
[Server-README](../README.md#vollständige-env-referenz).

### Nur Option B und C: Variablen der Compose-`.env`

| Variable | Zweck | Default |
|---|---|---|
| `DOMAIN` | öffentliche Domain des Stacks (Caddy holt dafür das TLS-Zertifikat) | – (Pflicht) |
| `POSTGRES_PASSWORD` | Passwort der Wiki.js-Datenbank | – (Pflicht) |
| `MCP_SESSION_SECRET` | siehe oben | – (Pflicht) |
| `PUBLIC_BASE_URL` | abweichende öffentliche Adresse | `https://$DOMAIN` |
| `WIKIJS_DB_POOL_MIN` / `WIKIJS_DB_POOL_MAX` | Verbindungspool von Wiki.js (nur Variante 1) | `2` / `20` |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` | Backup-Intervall und Anzahl aufbewahrter Stände | `86400` / `7` |
| `MCP_IMAGE` | Image des MCP-Servers (Variante 1: fertiges Image statt lokalem Build) | `wikijs-mcp:local` (Variante 1) / `ghcr.io/janschachtschabel/mcp-wiki-js-ai:main` (Variante 2, Option B) |
| `HTTP_PORT` / `HTTPS_PORT` | Host-Ports von Caddy (nur Variante 2; für Let's Encrypt bei 80/443 lassen) | `80` / `443` |
| `MCP_PORT` | lokaler Port des MCP für den vorhandenen Proxy (nur Option B, bindet an `127.0.0.1`) | `3100` |

### Nur Option C: Parameter des Bootstraps (`docker compose run --rm bootstrap …`; Variante 2: automatisch beim Start)

| Parameter | Zweck |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | erstes Admin-Konto (Pflicht, aus Shell oder `.env`) |
| `--locale=de` | Standardsprache setzen und vorhandene Seiten migrieren |
| `--demo` | zusätzlich Gruppe „Team“ + Testnutzer — nur für Test-Instanzen; braucht `DEMO_PASSWORD` (optional `DEMO_EMAIL`, Default `test@team.local`, und `DEMO_NAME`) |
| `BOOTSTRAP_ARGS` | nur Variante 2: die Parameter oben als Variable, Default `--locale=de` (z. B. `--locale=de --demo`) |

Die öffentliche Adresse für die Seite `/ki-zugang` nimmt der Dienst automatisch aus `PUBLIC_BASE_URL`
bzw. `https://$DOMAIN`.

Der Server prüft die Konfiguration beim Start und **startet bei Fehlern nicht** (z. B. Secret unter
16 Zeichen, unbekannter Rollenname, ungültiges JSON in einer Variable). Die Ursache steht im Log
(`docker compose logs mcp` bzw. `kubectl logs`) mit dem Präfix `[wikijs-mcp]`. Warnungen (z. B.
`PUBLIC_BASE_URL` ohne `MCP_SESSION_SECRET` — OAuth ist dann aus) stehen ebenfalls dort, der Server
startet trotzdem.

## Nutzung durch die Anwender

Anwender brauchen **nur die eine Adresse** – keine Keys, keine Tokens, keine Extra-Konten:

```
https://<domain>/mcp
```

**So funktioniert es für jede Person:**

1. Im KI-Programm die MCP-Adresse eintragen:
   - **claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector → URL einfügen
   - **Claude Code:** `claude mcp add --transport http wiki https://<domain>/mcp`, danach `/mcp` → *Authenticate*
   - **ChatGPT / Codex / Cursor:** Connector bzw. MCP-Server mit der URL anlegen
2. Beim ersten Verbinden öffnet sich automatisch der Browser und **springt zum Wiki-Login**.
   Dort mit dem **normalen Wiki-Konto** anmelden (ist man im Wiki schon angemeldet, genügt ein Klick auf „Zulassen").
3. Fertig. Die KI arbeitet ab jetzt **mit den eigenen Wiki-Rechten** dieser Person:
   sie sieht und ändert nur, was die Person selbst im Wiki sehen und ändern darf.
   Das Wiki muss dafür nicht geöffnet sein.

**Gut zu wissen:**

- Es gibt keine separate Benutzerverwaltung für den MCP – Konto, Passwort und Rechte kommen allein aus Wiki.js.
- Löschen und Admin-Aktionen liefern zuerst nur eine Vorschau; ausgeführt wird erst beim zweiten Aufruf mit `confirm`.
  Das ist eine Bremse, keine menschliche Freigabe — die KI setzt `confirm` selbst. Was jemand darf, entscheidet Wiki.js.
- Seiten mit dem Tag `kein-ki` sind für die KI unsichtbar und nicht änderbar.
- Eigene KI-Verbindungen ansehen und jederzeit widerrufen: `https://<domain>/me`.
- Rechteänderungen im Wiki (Gruppen, Page-Rules) gelten auch für die KI, da Wiki.js sie serverseitig durchsetzt.
- Meldet sich der Browser nach dem Login wieder ab, blockiert meist ein Werbe-/Tracking-Blocker
  (z. B. Brave Shields) die Cookies der Wiki-Domain.

## Troubleshooting

| Symptom | Ursache |
|---|---|
| Login zeigt Formular statt Ein-Klick | Wiki und MCP nicht auf derselben Domain, oder Cookie-Blocker im Browser |
| OAuth-Fehler / falsche Redirects | `PUBLIC_BASE_URL` passt nicht zur öffentlichen Domain |
| `/mcp` liefert die Wiki-Seite | Ingress-/Proxy-Pfade fehlen oder sind zu spät in der Regelreihenfolge |
| Sessions nach Neustart weg | `/data` ist kein persistentes Volume |
| MCP-Container/Pod startet nicht (Exit 1) | Konfigurationsfehler – Log-Zeile `[wikijs-mcp] …` lesen (siehe oben) |
| `413 Payload Too Large` | Anfrage an `/mcp` über 4 MB (z. B. großer Datei-Upload per KI) – Datei direkt im Wiki hochladen |
| `docker compose` bricht mit „DOMAIN fehlt“ ab | `DOMAIN` in `.env` leer oder `.env` fehlt |
| Docker-Panel meldet beim Compose-Import „nicht gefunden“ | Repo-`docker-compose.yml` braucht Build und Repo-Dateien – `deploy/standalone/docker-compose.full.yml` bzw. `…mcp-only.yml` nehmen (Option C Variante 2 / Option B) |
| Bootstrap meldet „Admin-Login schlägt fehl“ | Wiki ist schon eingerichtet, `ADMIN_PASSWORD` passt nicht mehr – Variable entfernen |
| Login meldet „Zu viele Anmeldeversuche“ | Login-Limit: 10 Versuche pro IP bzw. 5 pro Benutzername in 15 Minuten |
| Client-Registrierung liefert `429` | mehr als 20 Registrierungen pro IP und Stunde |
| `/api/health` liefert `503` | OAuth-Session-Store (sqlite unter `/data`) antwortet nicht – Volume/Rechte prüfen |

Vertiefung: [Integration in bestehendes Wiki](./integration-bestehendes-wiki.md) ·
[Konzept & Rechtemodell](./konzept-ki-zugang.md) · [OAuth](./oauth.md)
