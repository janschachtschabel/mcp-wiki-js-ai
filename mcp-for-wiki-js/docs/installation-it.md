# Installation – Anleitung für die IT

> 🇬🇧 English version: [installation-it.en.md](installation-it.en.md)

Der MCP-Server macht ein [Wiki.js](https://js.wiki/) 2.x für KI-Programme (Claude, ChatGPT, Cursor …)
nutzbar. Anwender tragen nur eine Adresse ein (`https://<domain>/mcp`) und melden sich mit ihrem
normalen Wiki-Konto an; die KI arbeitet dann mit genau deren Wiki-Rechten.

## Welcher Fall liegt vor?

| Fall | Ausgangslage | Weg | Datei / Werkzeug |
|---|---|---|---|
| **A: Komplett** | Noch kein Wiki. Wiki.js und MCP sollen zusammen laufen. | **A1** Docker-Panel des Hosters, Import aus dem Git-Repo, Traefik läuft dort schon | [`docker-compose.yml`](../../docker-compose.yml) (Hauptordner) |
| | | **A2** eigener Server ohne Reverse-Proxy | [`deploy/standalone/full/docker-compose.yml`](../../deploy/standalone/full/docker-compose.yml) |
| | | **A3** selbst bauen (Repo-Checkout, eigene Registry, Entwicklung) | [`docker-compose.build.yml`](../../docker-compose.build.yml) |
| | | **A4** Kubernetes | [Helm-Chart `wikijs-stack`](../../deploy/helm/wikijs-stack/README.md) |
| **B: MCP zum bestehenden Wiki** | Wiki.js läuft schon unter einer Domain. Der MCP kommt unter **derselben Adresse** dazu, das Wiki bleibt unverändert. | **B1** vor dem Wiki steht Traefik (eigener oder der eines Docker-Panels) | [`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml) mit `TRAEFIK_ENABLE=true` |
| | | **B2** vor dem Wiki steht nginx, Caddy, Apache o. ä. | dieselbe Datei + Pfad-Regeln im Proxy |
| | | **B3** Wiki.js läuft in Kubernetes | [Helm-Chart](../../deploy/helm/wikijs-mcp/README.md) |
| **C: Nur MCP** | Wiki.js läuft woanders, am Proxy der Wiki-Domain lässt sich nichts ändern (z. B. fremd gehostet). | **C1** MCP unter eigener Adresse (z. B. `mcp.example.org`) | [`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml) |
| | | **C2** eine Person nutzt den MCP lokal auf dem eigenen Rechner | `npm run stdio` mit persönlichem API-Key |

**Gemeinsame Regeln**

- **Gleiche Domain für Wiki und MCP** (Fälle A und B): Dann gilt die Wiki-Anmeldung auch beim
  Verbinden der KI — ein Klick auf „Zulassen“ statt eines zweiten Logins. Bei eigener Adresse (C1)
  funktioniert alles ebenso, nur fragt die Freigabeseite die Wiki-Zugangsdaten per Formular ab.
- Der MCP-Server läuft als **eigener Container/Pod**, nicht im Wiki-Container.
- Diese Pfade gehören dem MCP-Server, im Wiki dort **keine Seiten** anlegen:
  `/mcp`, `/oauth/…`, `/me`, `/_next/…`, `/api/health`, `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/.well-known/mcp.json`.
- KI-Nutzern in Wiki.js **nie `manage:system`** geben — das hebelt alle Seitenregeln aus.
- Die Compose-Dateien der Wege A1, A2, B1, B2 und C1 laden das fertige Image
  `ghcr.io/janschachtschabel/mcp-wiki-js-ai:main` (öffentlich, kein Login), brauchen **keine
  Pflicht-Variablen** und erzeugen ihre Geheimnisse beim ersten Start selbst (Dienst `init`, Volume
  `stack-secrets` — gehört zur Datensicherung).

---

## A: Wiki.js und MCP komplett

Alle Wege bringen Postgres, Wiki.js, den MCP-Server und ein tägliches Backup mit. Die
Ersteinrichtung (Admin-Konto, Startseite, Anleitungsseite `/ki-zugang`, PostgreSQL-Suche, Sprache)
läuft bei A1, A2 und A4 automatisch, sobald Domain und Admin-Zugang gesetzt sind.
Voraussetzung immer: ein DNS-A-Eintrag der Domain zeigt auf den Server.

### A1: Docker-Panel mit Traefik (Import aus dem Git-Repo)

Docker-Panels mancher Hoster bauen Projekte direkt aus einem Git-Repository. Beobachtetes Verhalten,
das die Datei berücksichtigt:

- Das Panel liest **nur die `docker-compose.yml` im Hauptordner** des Repos (ein Pfad zu einem
  Unterordner in der URL wird ignoriert) und kopiert `.env.example` als `.env`.
- Variablen lassen sich erst bearbeiten, wenn das Projekt existiert — und es entsteht nur, wenn die
  erste Bereitstellung gelingt. Ein Fehler zeigt sich lediglich als „Bereitstellung fehlgeschlagen“
  oder „Docker project not found“.
- Auf dem Server läuft bereits ein **Traefik** auf den Ports 80/443 (im Host-Netzwerkmodus) mit dem
  HTTPS-Eingang `websecure` und dem Zertifikatsdienst `letsencrypt`.

**Ablauf**

1. Im Panel *Compose from URL* (o. ä.) mit `https://github.com/janschachtschabel/mcp-wiki-js-ai`,
   ohne Variablen bereitstellen. Alle Container starten; `init` und `bootstrap` beenden sich danach
   (Status „Exited“ ist dort normal).
2. Projekt bearbeiten, in der `.env` setzen und neu bereitstellen:
   ```
   DOMAIN=wiki.example.org        # nur der Hostname — kein https://, kein Pfad
   ADMIN_EMAIL=admin@example.org
   ADMIN_PASSWORD=…
   ```
   Ohne eigene Domain taugt der Hostname, den der Hoster dem Server gibt (z. B.
   `srv123456.<hoster-domain>`), sofern er per DNS auf den Server zeigt.
3. Nach ein bis zwei Minuten prüfen: `https://<DOMAIN>/api/health` liefert `{"ok":true,"store":"ok"}`;
   das Log des Containers `bootstrap` endet mit „Fertig“.
4. `ADMIN_PASSWORD` wieder leeren und neu bereitstellen; dann [Nach der Einrichtung](#nach-der-einrichtung).

Traefik übernimmt HTTPS und Zertifikat. Per Labels gehen die MCP-Pfade an den MCP-Server, alles
andere an Wiki.js; `/finalize` (der Setup-Assistent von Wiki.js, der das erste Admin-Konto anlegt)
geht an den MCP-Server und endet dort mit 404. Die Datei setzt kein vorhandenes Docker-Netz voraus:
Sie legt ihr eigenes Netz `wikijs-web` an. Läuft Traefik nicht im Host-Modus, sondern in einem
eigenen Docker-Netz, dessen Namen als `TRAEFIK_NETWORK` setzen (Variablen: [Nur Komplett-Stacks](#nur-komplett-stacks-a)).

### A2: Eigener Server ohne Reverse-Proxy

```bash
mkdir wikijs && cd wikijs
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/full/docker-compose.yml
printf 'DOMAIN=wiki.example.org\nADMIN_EMAIL=admin@example.org\nADMIN_PASSWORD=...\n' > .env
docker compose up -d
```

Ein mitgelieferter **Caddy** belegt die Ports 80/443 und holt das Zertifikat selbst. `init` schreibt
seine Konfiguration aus der Vorlage [`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile) (im Image
enthalten); ohne `DOMAIN` zeigt die Seite „noch nicht eingerichtet“. Sind 80/443 schon belegt (anderer
Proxy auf dem Server), A1 nehmen bzw. Wiki.js hinter diesen Proxy stellen und den MCP nach B ergänzen.
Docker-Panels **ohne** Traefik, die Unterordner unterstützen, können diese Datei per Repository +
Pfad `deploy/standalone/full` importieren — dann wie bei A1 in zwei Schritten.

### A3: Selbst bauen (Repo-Checkout)

```bash
git clone https://github.com/janschachtschabel/mcp-wiki-js-ai.git && cd mcp-wiki-js-ai
cp .env.example .env
```
In der `.env` setzen (mit `COMPOSE_FILE` gelten alle `docker compose …`-Befehle ohne `-f`):
```
COMPOSE_FILE=docker-compose.build.yml
DOMAIN=wiki.example.org
POSTGRES_PASSWORD=<openssl rand -base64 24>
MCP_SESSION_SECRET=<openssl rand -base64 32>
```
Starten und einrichten:
```bash
docker compose up -d
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' docker compose run --rm bootstrap --locale=de
```
Das Image wird lokal gebaut, Caddy belegt 80/443, Wiki.js bekommt einen größeren DB-Pool
([`deploy/wiki/config.yml`](../../deploy/wiki/config.yml)). Den Setup-Endpunkt `/finalize` beantwortet
Caddy von außen mit 403; `bootstrap` spricht im internen Docker-Netz direkt mit Wiki.js. Lokal ohne
Domain/TLS testen: `docker compose -f docker-compose.build.yml -f docker-compose.local.yml up -d`
(dann `http://localhost:8090`), Einrichtung mit denselben `-f`-Angaben vor `run --rm bootstrap`.

### A4: Kubernetes (Helm-Chart `wikijs-stack`)

Postgres, Wiki.js, MCP-Server, Ingress (eine Domain), Ersteinrichtung als Job und tägliches Backup als
CronJob in einem Release:
```bash
kubectl create namespace wiki
kubectl -n wiki create secret generic wiki-admin --from-literal=ADMIN_PASSWORD='…'
helm install wiki ./deploy/helm/wikijs-stack -n wiki   --set domain=wiki.example.org   --set admin.email=admin@example.org --set admin.existingSecret=wiki-admin
```
Datenbank-Passwort und `MCP_SESSION_SECRET` erzeugt das Chart einmalig und behält sie (bei GitOps-Werkzeugen
wie Argo CD stattdessen `secrets.existingSecret`). Vorlage mit allen üblichen Einstellungen:
[`values-example.yaml`](../../deploy/helm/wikijs-stack/values-example.yaml) · Details und Werte:
[Chart-README](../../deploy/helm/wikijs-stack/README.md).

### Nach der Einrichtung

1. Bei A1/A2 `ADMIN_PASSWORD` leeren und neu bereitstellen (das Konto bleibt).
2. Im Wiki unter Administration → Gruppen eine Gruppe „Team“ anlegen: Seiten, Dateien und Kommentare
   lesen/schreiben, dazu `read:source` und `read:history` — **ohne** `manage:system`.
3. Nutzer anlegen (Administration → Benutzer) und der Gruppe zuordnen. Ohne eingerichteten Mailserver
   (Administration → Mail) Passwörter beim Anlegen selbst vergeben.
4. Anwendern die Adresse `https://<DOMAIN>/mcp` geben — die Anleitung steht schon im Wiki unter
   `https://<DOMAIN>/ki-zugang`.

---

## B: MCP zu einem bestehenden Wiki.js (gleiche Adresse)

Das Wiki bleibt unangetastet (kein Fork, keine Migration). Der MCP-Server läuft daneben, und der
Proxy vor dem Wiki gibt die MCP-Pfade an ihn weiter. Für B1 und B2 genügt **eine** Datei,
[`deploy/standalone/mcp-only/docker-compose.yml`](../../deploy/standalone/mcp-only/docker-compose.yml):

```bash
mkdir wikijs-mcp && cd wikijs-mcp
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/janschachtschabel/mcp-wiki-js-ai/main/deploy/standalone/mcp-only/docker-compose.yml
```

Sie startet ohne Variablen (das Session-Secret erzeugt `init`). Gesetzt werden mindestens:

```
DOMAIN=wiki.example.org                     # Hostname des Wikis (ohne https://)
WIKIJS_URL=https://wiki.example.org         # wie der MCP das Wiki erreicht (siehe unten)
```

**`WIKIJS_URL` wählen:** Die Wiki-Domain funktioniert immer. `http://host.docker.internal:3000`
(Default) passt, wenn Wiki.js auf demselben Host mit veröffentlichtem Port 3000 läuft — nicht, wenn
der Port nur an `127.0.0.1` gebunden ist. Hat die Wiki-Domain ein firmeninternes Zertifikat, siehe
[Adressen](#adressen-wikijs_url-und-domain).

### B1: Vor dem Wiki steht Traefik

Zusätzlich `TRAEFIK_ENABLE=true` setzen und starten (`docker compose up -d` bzw. im Panel per
*Compose manually* mit dem Dateiinhalt). Der MCP-Container trägt dann Traefik-Labels: Auf `DOMAIN`
gehen nur die MCP-Pfade an ihn (Priorität 100), alle anderen Anfragen behalten ihren bisherigen
Router zum Wiki. Voraussetzungen:

- Traefik erreicht das Netz des MCP-Containers: im Host-Modus automatisch; läuft Traefik in einem
  eigenen Docker-Netz, dessen Namen als `TRAEFIK_NETWORK` setzen.
- Eingangs- und Zertifikatsnamen passen (`TRAEFIK_ENTRYPOINT`, Default `websecure`;
  `TRAEFIK_CERTRESOLVER`, Default `letsencrypt`).
- Der Router des Wikis hat keine höhere Priorität als 100 (Standard: Länge der Regel, also deutlich
  kleiner).

### B2: Vor dem Wiki steht nginx, Caddy, Apache o. ä.

Der MCP lauscht nur lokal auf `127.0.0.1:3100` (`MCP_PORT`). Im vorhandenen Proxy der Wiki-Domain die
MCP-Pfade dorthin geben; alles andere bleibt beim Wiki. Wichtig für alle Proxys:
`X-Forwarded-For` **anhängen** (die Login-Sperre zählt pro Client-IP) und Antworten **nicht puffern**
(Streaming). Alle drei Beispiele sind mit diesem Projekt getestet.

**nginx** — im bestehenden `server { … }`-Block der Wiki-Domain (Regex-Locations haben Vorrang vor
der `location /` des Wikis):
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

**Caddy** — im bestehenden Site-Block; der bisherige `reverse_proxy` zum Wiki wandert ins letzte `handle`:
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

**Apache** (`mod_proxy`, `mod_proxy_http`, `mod_headers`) — im `<VirtualHost *:443>` der Wiki-Domain,
**vor** dem `ProxyPass` für das Wiki:
```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"
ProxyPassMatch "^/(mcp(/.*)?|oauth/.*|me(/.*)?|_next/.*|api/health|\.well-known/(oauth-authorization-server.*|oauth-protected-resource.*|mcp\.json))$" "http://127.0.0.1:3100/$1" flushpackets=on
```

Andere Proxys (Panel-Proxys, HAProxy …): dieselben Pfade per Pfad-Regel auf `127.0.0.1:3100`.

**Ohne Compose:** gleiche Werte als `docker run`, z. B. im Docker-Netz des Wikis:
```bash
docker run -d --name wikijs-mcp --restart unless-stopped --network <netz-des-wikis> \
  -p 127.0.0.1:3100:3000 -v mcp-data:/data \
  -e WIKIJS_URL=http://<wiki-container>:3000 -e PUBLIC_BASE_URL=https://wiki.example.org \
  -e MCP_SESSION_SECRET="$(openssl rand -base64 32)" \
  ghcr.io/janschachtschabel/mcp-wiki-js-ai:main
```
(Das Secret dann notieren und bei jedem Neuanlegen wieder verwenden, sonst sind alle Verbindungen weg.)

### B3: Wiki.js läuft in Kubernetes

1. **Secret anlegen** (steht so weder in einer Values-Datei noch in der Helm-Historie):
   ```bash
   kubectl -n <namespace> create secret generic wikijs-mcp-secret \
     --from-literal=MCP_SESSION_SECRET="$(openssl rand -base64 32)"
   ```
2. **Werte setzen:** `cp deploy/helm/wikijs-mcp/values-prod.example.yaml values-prod.yaml`, darin:
   ```yaml
   global:
     image:
       registry: ghcr.io                                 # oder eigene Registry
       repository: janschachtschabel/mcp-wiki-js-ai
   image:
     tag: "main"                                         # besser ein Release-Tag
   config:
     existingSecret: wikijs-mcp-secret
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
3. **Deployen:** `helm install wikijs-mcp deploy/helm/wikijs-mcp -n <namespace> -f values-prod.yaml`

Das Chart legt auf der Wiki-Domain einen Ingress nur für die MCP-Pfade an; `replicaCount` bleibt
**1** (Sessions liegen in einer SQLite-Datei auf dem PVC). Eigenes Image: im Repo-Root
`docker build -t <registry>/<pfad>:<tag> .` und pushen. Details: [Helm-README](../../deploy/helm/wikijs-mcp/README.md).

### Nach der Einrichtung (B)

1. Prüfen: `https://<domain>/api/health` → `{"ok":true,"store":"ok"}`;
   `https://<domain>/.well-known/oauth-authorization-server` → JSON; `https://<domain>/` → weiterhin das Wiki.
2. Gruppe „Team“ wie unter [A — Nach der Einrichtung](#nach-der-einrichtung) (ohne `manage:system`).
3. Empfohlen: Administration → Suchmaschine → **PostgreSQL** (Wörterbuch passend zur Sprache) —
   deutlich bessere Suche für KI-Agenten. Nutzt Wiki.js den Standard-DB-Pool (10 Verbindungen),
   `WIKIJS_MAX_CONCURRENCY` bei `6` lassen.

---

## C: Nur der MCP-Server

### C1: MCP unter eigener Adresse (Wiki läuft woanders)

Für ein Wiki, an dessen Proxy sich nichts ändern lässt. Der MCP bekommt eine eigene Domain, z. B.
`mcp.example.org`, mit derselben Datei wie bei B:

```
DOMAIN=mcp.example.org                      # Adresse des MCP (DNS → dieser Server)
WIKIJS_URL=https://wiki.example.org         # das vorhandene Wiki
```

Davor gehört ein Proxy mit TLS — entweder ein vorhandener Traefik (`TRAEFIK_ENABLE=true`, Labels wie
bei B1) oder z. B. ein Caddy auf dem Server:
```caddy
mcp.example.org {
	reverse_proxy 127.0.0.1:3100
}
```
Anwender tragen `https://mcp.example.org/mcp` ein. Weil die Wiki-Sitzung auf dieser Domain nicht gilt,
fragt die Freigabeseite einmalig die Wiki-Zugangsdaten per Formular ab; Rechte, Sperren und `/me`
funktionieren unverändert. Der MCP braucht Netzzugriff auf das Wiki (GraphQL über HTTPS).

### C2: Lokal auf dem eigenen Rechner (eine Person)

Ohne Server: Claude Desktop oder ein anderes Programm startet den MCP-Server lokal über stdio und
spricht mit einem **persönlichen Wiki.js-API-Key** (Administration → API-Zugang). Die Rechte hängen
dann am Key, nicht an der Person. Einrichtung: [Server-README, „Claude Desktop (lokal, stdio)“](../README.md#claude-desktop-lokal-stdio).

---

## Adressen: `WIKIJS_URL` und `DOMAIN`

| Variable | Wofür | Beispiele |
|---|---|---|
| `WIKIJS_URL` | wie der MCP-Server das Wiki erreicht (GraphQL) — intern oder öffentlich | `http://wiki:3000` (gleiches Compose-Netz), `http://<service>.<namespace>.svc:3000` (Kubernetes), `http://host.docker.internal:3000` (gleicher Host), `https://wiki.example.org` |
| `DOMAIN` | unter welchem Hostnamen Anwender und KI-Programme den MCP erreichen; daraus wird `PUBLIC_BASE_URL=https://<DOMAIN>` | `wiki.example.org` (Fall A/B), `mcp.example.org` (C1) |

Eine IP ist nie nötig, jede Domain geht. Liegen Wiki und MCP im selben Docker-Netz oder Cluster, ist die
interne Adresse die robustere Wahl. Hat die Wiki-Domain ein **firmeninternes Zertifikat**, muss Node
die Zertifizierungsstelle kennen: PEM-Datei in den Container mounten und
`NODE_EXTRA_CA_CERTS=/pfad/ca.pem` setzen (Compose: per Override-Datei); im Helm-Chart dafür die
interne Service-Adresse per `http://` nehmen.

---

## Umgebungsvariablen

### Für alle Compose-Dateien (in der `.env` neben der Datei bzw. im Panel)

| Variable | Bedeutung | Default |
|---|---|---|
| `DOMAIN` | Hostname, **ohne** `https://` und ohne Pfad. Steht doch `https://` darin, bricht `init` mit klarer Meldung ab | leer (A1/A2/B/C1: anfangs leer erlaubt) · A3: Pflicht |
| `WIKIJS_BLOCKED_TAGS` | Seiten mit diesen Tags sind für die KI unsichtbar und gesperrt (kommagetrennt, leer = aus) | `kein-ki` |
| `WIKIJS_MAX_CONCURRENCY` | max. gleichzeitige Anfragen an Wiki.js (unter dem DB-Pool des Wikis halten) | `6` (A3: `12`) |
| `WIKIJS_OAUTH_ROLE` | Schutzrolle für KI-Sitzungen: Löschen/Admin erst nach Bestätigungsschritt | `wiki` |
| `WIKIJS_PERMISSION_PRESET` | Obergrenze der sichtbaren Tools; bei OAuth `full` lassen (die Rechte kommen aus Wiki.js) | `full` |
| `WIKIJS_AUDIT` | Audit-Log (Tool, Nutzer, Ergebnis) an/aus | `true` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | nur an diese Hosts dürfen OAuth-Clients zurückleiten (kommagetrennt, z. B. `claude.ai,chatgpt.com`); Loopback immer erlaubt | leer = jeder https-Host |
| `MCP_IMAGE` | anderes Image/Tag, z. B. ein Release-Tag `ghcr.io/janschachtschabel/mcp-wiki-js-ai:v1.2.3` | `…:main` (A3: `wikijs-mcp:local`) |
| `TZ` | Zeitzone der Zeitangaben auf `/me` | `UTC` |

### Nur Komplett-Stacks (A)

| Variable | Bedeutung | Default |
|---|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | erstes Admin-Konto. A1/A2: wird beim Start angelegt, danach `ADMIN_PASSWORD` leeren. A3: beim `run --rm bootstrap` | – |
| `BOOTSTRAP_ARGS` | zusätzliche Parameter der Ersteinrichtung (A1/A2): `--locale=en` (andere Sprache; Deutsch ist voreingestellt), `--demo` (Gruppe „Team“ + Testnutzer, nur für Tests; braucht `DEMO_PASSWORD`, optional `DEMO_EMAIL`, `DEMO_NAME`) | – |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` | Abstand und Anzahl der Backups (Postgres + MCP-SQLite, Volume `db-backups`) | `86400` / `7` |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` | Namen im vorhandenen Traefik (nur A1) | `websecure` / `letsencrypt` |
| `TRAEFIK_NETWORK` | Netz, über das Traefik den Stack erreicht; wird angelegt. Nur ändern, wenn Traefik in einem eigenen Docker-Netz läuft (nur A1) | `wikijs-web` |
| `HTTP_PORT` / `HTTPS_PORT` | Host-Ports des mitgelieferten Caddy (nur A2; für Let's Encrypt 80/443 lassen) | `80` / `443` |
| `COMPOSE_FILE` | `docker-compose.build.yml` — dann gelten `docker compose …`-Befehle ohne `-f` (nur A3) | – |
| `POSTGRES_PASSWORD`, `MCP_SESSION_SECRET` | nur A3 Pflicht; A1/A2 erzeugen sie selbst | – |
| `PUBLIC_BASE_URL` | abweichende öffentliche Adresse (nur A3) | `https://$DOMAIN` |
| `WIKIJS_DB_POOL_MIN` / `WIKIJS_DB_POOL_MAX` | DB-Pool von Wiki.js (nur A3) | `2` / `20` |

### Nur MCP-Datei (B1, B2, C1)

| Variable | Bedeutung | Default |
|---|---|---|
| `WIKIJS_URL` | Adresse des vorhandenen Wikis (ohne `/graphql`) | `http://host.docker.internal:3000` |
| `MCP_PORT` | lokaler Port für einen Proxy auf dem Host (nur an `127.0.0.1` gebunden) | `3100` |
| `TRAEFIK_ENABLE` | `true` = Traefik-Labels aktiv (B1, C1 mit Traefik) | `false` |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` / `TRAEFIK_NETWORK` | wie bei A1 | `websecure` / `letsencrypt` / `wikijs-mcp-web` |

Alle weiteren Variablen des Servers (Legacy-Zugang mit API-Keys, Limits, Diagnose):
[vollständige Referenz in der Server-README](../README.md#vollständige-env-referenz). Der Server
prüft die Konfiguration beim Start und **startet bei Fehlern nicht**; die Ursache steht im Log mit dem
Präfix `[wikijs-mcp]`.

---

## Nutzung durch die Anwender

Anwender brauchen **nur eine Adresse** — keine Keys, keine Extra-Konten:
`https://<domain>/mcp`

1. Im KI-Programm eintragen:
   - **claude.ai / Claude Desktop:** Einstellungen → Connectors → *Add custom connector* → URL
   - **Claude Code:** `claude mcp add --transport http wiki https://<domain>/mcp`, danach `/mcp` → *Authenticate*
   - **ChatGPT, Cursor u. a.:** MCP-Server bzw. Connector mit der URL anlegen
2. Beim ersten Verbinden öffnet sich der Browser mit dem Wiki-Login. Mit dem normalen Wiki-Konto
   anmelden bzw. — wenn schon angemeldet — auf „Zulassen“ klicken.
3. Fertig. Die KI arbeitet mit den Wiki-Rechten dieser Person; das Wiki muss nicht geöffnet sein.

Gut zu wissen: Löschen und Admin-Aktionen liefern zuerst eine Vorschau (die KI bestätigt im zweiten
Schritt selbst — eine Bremse, keine menschliche Freigabe). Seiten mit dem Tag `kein-ki` sieht die KI
nicht. Eigene Verbindungen ansehen und widerrufen: `https://<domain>/me`. Die Anleitung für Anwender
steht bei Fall A bereits im Wiki unter `/ki-zugang`.

---

## Betrieb

| Aufgabe | Wie |
|---|---|
| Update | `docker compose pull && docker compose up -d` bzw. im Panel neu bereitstellen (A3 zusätzlich `docker compose build --pull mcp`). `:main` folgt dem Hauptzweig; feste Stände per `MCP_IMAGE` mit Release-Tag |
| Logs | `docker compose logs -f <dienst>` bzw. im Panel; nützlich: `init`, `bootstrap`, `mcp` |
| Backup | Fall A: automatisch täglich ins Volume `db-backups` — **off-host kopieren**. Immer mitsichern: Volumes `stack-secrets` (Passwörter; ohne sie startet Wiki.js nach einem Restore nicht) und `mcp-data` (Sessions, Audit-Log) |
| Domain später ändern | `DOMAIN` ändern und neu bereitstellen; im Wiki zusätzlich die Site-URL (Administration → Allgemein) und die Seite `/ki-zugang` anpassen; KI-Programme neu verbinden |
| Alles löschen | `docker compose down -v` (**löscht alle Daten**) |

---

## Fehlerbehebung

| Symptom | Ursache / Lösung |
|---|---|
| Panel: „Bereitstellung fehlgeschlagen“ / „Docker project not found“ | Die erste Bereitstellung ist gescheitert. Die echte Meldung steht im Projektordner des Panels (z. B. `/docker/<projekt>/.build.log`, per Web-Konsole) |
| Log von `init`: „DOMAIN=… ist kein reiner Hostname“ | In `DOMAIN` steht `https://` oder ein Pfad — nur den Hostnamen eintragen |
| Domain liefert Traefiks `404 page not found` mit „TRAEFIK DEFAULT CERT“ | Traefik hat keine Route: `DOMAIN` leer oder falsch, `TRAEFIK_ENABLE` fehlt (B1/C1), oder Namen weichen ab (`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`, `TRAEFIK_NETWORK`). Log des Traefik-Containers lesen |
| `network … declared as external, but could not be found` | ältere Fassung der Datei — neu importieren (aktuelle Dateien legen ihr Netz selbst an) |
| Ports 80/443 belegt („address already in use“) | Auf dem Server läuft schon ein Proxy — A1 bzw. B statt A2/A3 |
| Panel: „YAML-Datei kann nicht verarbeitet werden“ | Datei neu importieren; hilft das nicht, per SSH mit `docker compose up -d` starten |
| `docker compose` bricht mit „DOMAIN fehlt“ ab | nur A3: `DOMAIN` in der `.env` leer |
| `bootstrap`: „Admin-Login schlägt fehl“ | Wiki ist schon eingerichtet und `ADMIN_PASSWORD` passt nicht mehr — Variable leeren |
| `/mcp` liefert die Wiki-Seite | MCP-Pfade im Proxy fehlen oder greifen zu spät (Reihenfolge/Priorität) |
| Login zeigt Formular statt Ein-Klick | Wiki und MCP nicht auf derselben Domain (bei C1 normal) oder Cookie-/Tracking-Blocker im Browser |
| OAuth-Fehler / falsche Weiterleitungen | `DOMAIN` bzw. `PUBLIC_BASE_URL` passt nicht zur Adresse, die Anwender eintragen |
| „Zu viele Anmeldeversuche“ | Login-Sperre: 10 Versuche pro IP bzw. 5 pro Konto in 15 Minuten |
| Client-Registrierung liefert `429` | mehr als 20 Registrierungen pro IP und Stunde |
| `/api/health` liefert `503` | Session-Speicher (SQLite unter `/data`) nicht erreichbar — Volume/Rechte prüfen |
| Sessions nach Neustart weg | `/data` bzw. `stack-secrets` sind keine dauerhaften Volumes |
| `413 Payload Too Large` | Anfrage über 4 MB (z. B. große Datei per KI) — Datei direkt im Wiki hochladen |

Vertiefung: [Konzept & Rechtemodell](./konzept-ki-zugang.md) · [OAuth](./oauth.md) ·
[Server-README](../README.md)
