# Installation – Kurzanleitung für die IT

Zwei Wege, den MCP-Server für Wiki.js zu betreiben:

| | Option A: bestehendes Wiki (Kubernetes) | Option B: Neuinstallation (Docker Compose) |
|---|---|---|
| Wiki.js | läuft bereits, bleibt unverändert | wird mit aufgesetzt |
| Was wird installiert | nur der MCP-Server (eigener Pod) | Postgres + Wiki.js + MCP + Caddy (HTTPS) + Backup |
| Zeitaufwand | ca. 15 Min. | ca. 20 Min. |

Gemeinsame Regeln für beide Optionen:

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
Im Repo-Root bauen und pushen (oder das von der CI gebaute Image aus GHCR/GitLab nutzen):
```bash
docker build -t <registry>/wikijs-mcp:1 .
docker push <registry>/wikijs-mcp:1
```

### 2. Secret erzeugen
```bash
openssl rand -base64 32      # → MCP_SESSION_SECRET
```

### 3. Mit Helm deployen
Chart: [`deploy/helm/wikijs-mcp`](../../deploy/helm/wikijs-mcp/README.md). Eigene `values-prod.yaml`:
```yaml
global:
  image:
    registry: <registry>
    repository: wikijs-mcp
image:
  tag: "1"
config:
  wikijs:
    url: http://<wiki-service>.<namespace>.svc:3000   # interner Service, ohne /graphql
  oauth:
    sessionSecret: "<secret aus Schritt 2>"
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
curl https://wiki.example.org/api/health                              # {"ok":true}
curl https://wiki.example.org/.well-known/oauth-authorization-server  # JSON
```

---

## Option B: Neuinstallation zusammen mit Wiki.js (Docker Compose)

Voraussetzungen: Linux-Host mit Docker Compose, Ports 80/443 erreichbar, DNS-Eintrag auf den Host,
Node ≥ 18 (nur für das Bootstrap-Skript).

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
ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='…' node deploy/scripts/bootstrap.mjs --locale=de
```
Das Bootstrap-Skript (idempotent) legt Admin-Konto, Startseite, PostgreSQL-Suche und deutsche
Oberfläche an. Danach Gruppe „Team" wie in Option A, Schritt 4 anlegen.

Lokal ohne Domain/TLS testen: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`
(erreichbar unter `http://localhost:8090`).

**Betrieb**

| Aufgabe | Befehl / Hinweis |
|---|---|
| Update | `docker compose pull && docker compose build --pull mcp && docker compose up -d` |
| Logs | `docker compose logs -f` |
| Backup | automatisch täglich (Postgres + MCP-SQLite), 7 Stück, Volume `db-backups` – **off-host replizieren** |
| Alles löschen | `docker compose down -v` (**löscht alle Daten**) |

---

## Konfiguration (Umgebungsvariablen des MCP-Servers)

| Variable | Zweck | Default |
|---|---|---|
| `WIKIJS_URL` | interne Adresse des Wiki.js (ohne `/graphql`) | – (Pflicht) |
| `PUBLIC_BASE_URL` | öffentliche URL (OAuth-Issuer), muss zur Domain passen | – (Pflicht) |
| `MCP_SESSION_SECRET` | schaltet OAuth ein, verschlüsselt den Session-Store in `/data` | – (Pflicht) |
| `WIKIJS_PERMISSION_PRESET` | Rechte-Ceiling; bei OAuth `full` lassen | `full` |
| `WIKIJS_BLOCKED_TAGS` | Seiten mit diesen Tags sind für KI unsichtbar (leer = aus) | `kein-ki` |
| `WIKIJS_AUDIT` | Audit-Log an/aus | `true` |

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
- Löschen und Admin-Aktionen führt die KI erst nach ausdrücklicher Bestätigung (`confirm`) aus.
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

Vertiefung: [Integration in bestehendes Wiki](./integration-bestehendes-wiki.md) ·
[Konzept & Rechtemodell](./konzept-ki-zugang.md) · [OAuth](./oauth.md)
