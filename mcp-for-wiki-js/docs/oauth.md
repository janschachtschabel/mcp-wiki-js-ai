# OAuth mit Wiki.js-Login — „der Wiki-Login ist der einzige Login"

Der empfohlene Betriebsmodus für self-hosted Deployments (Docker-Appliance im
Repo-Root). Ziele:

- **Keine Secrets und keine Personendaten in der Connector-URL** — alle nutzen
  dieselbe `https://<host>/mcp`; sie darf öffentlich im Wiki stehen.
- **Kein zusätzlicher Login, keine doppelte User-Pflege** — die Autorisierung
  ist der normale Wiki.js-Login. User werden ausschließlich in Wiki.js gepflegt.
- **Echte Per-User-Rechte** — jede Session trägt den **User-JWT** der Person;
  Wiki.js erzwingt deren Gruppen + Page-Rules serverseitig. Die Seiten-History
  zeigt die echte Person, nicht „API".

## Aktivieren

```bash
# 1. Secret erzeugen (verschlüsselt gespeicherte Sessions):
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2. Env setzen:
MCP_SESSION_SECRET=<das-secret>       # schaltet OAuth ein
WIKIJS_URL=http://wiki:3000           # interne Wiki-Adresse (Appliance) bzw. öffentliche URL
PUBLIC_BASE_URL=https://wiki.example.org   # öffentliche Basis (hinter Reverse-Proxy PFLICHT)
WIKIJS_PERMISSION_PRESET=full         # Ceiling öffnen — die echten Rechte kommen aus Wiki.js
WIKIJS_OAUTH_ROLE=wiki                # Agenten-Schutzschicht (confirm-Gates), s.u.
MCP_DATA_DIR=/data                    # sqlite-Session-Store (Volume!)
```

Ohne `MCP_SESSION_SECRET` bleibt alles wie zuvor (Handles/BYOK/stdio) — auch auf
Vercel, wo OAuth mangels persistenter Platte **nicht** verfügbar ist.

## Wie sich das für Nutzer anfühlt

1. MCP-URL in den Client eintragen (claude.ai Connector, `claude mcp add --transport http`,
   ChatGPT/Codex Connector, Cursor).
2. Der Client öffnet einmalig `https://<host>/oauth/authorize` im Browser:
   - **Wiki-Sitzung vorhanden** (gleiche Domain): Ein Klick auf „Zugriff erlauben". Fertig.
   - Sonst: normales Wiki-Login-Formular (inkl. 2FA-Schritt, falls aktiviert).
3. Ab dann läuft alles automatisch: Access-Token (1 h) werden per Refresh-Token
   im Hintergrund erneuert; der gespeicherte Wiki-JWT erneuert sich über Wiki.js'
   `new-jwt`-Mechanik bei jeder Nutzung.

**Sitzungsende:** Nach >14 Tagen Inaktivität (Wiki.js' `tokenRenewal`-Fenster)
läuft die Session aus — der Client startet die Ein-Klick-Freigabe erneut.
**Widerruf:** jederzeit unter `/me` (sofort wirksam).

## Technik (Kurzfassung)

- OAuth 2.1 Authorization-Code + PKCE (S256), Public Clients, **Dynamic Client
  Registration** (RFC 7591) — claude.ai/Codex registrieren sich selbst.
- Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) und
  `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728); unauthentifizierte
  `/mcp`-Requests bekommen den spec-konformen `401` + `WWW-Authenticate`.
- **Session-Store:** sqlite via `node:sqlite` (keine neue Dependency) unter
  `MCP_DATA_DIR`. Tokens werden nur als SHA-256-Hash gespeichert; der Wiki-JWT
  AES-256-GCM-verschlüsselt (Schlüssel via HKDF aus `MCP_SESSION_SECRET`).
- **Refresh-Rotation mit Reuse-Detection:** jeder Refresh tauscht Access- UND
  Refresh-Token; taucht ein bereits rotiertes Refresh-Token erneut auf
  (Diebstahl-Signal), wird die gesamte Session sofort widerrufen.
- **Loopback-Redirects** (`http://localhost:<port>/callback`) matchen
  port-agnostisch (RFC 8252) — nötig für Claude/Codex-CLI-Callbacks.
- Passwörter werden **nie gespeichert**, nur an Wiki.js' `login`-Mutation
  durchgereicht (deren eingebautes Rate-Limit 5/min greift).

## Rechte & Guardrails

| Schicht | Quelle | Wirkung |
|---|---|---|
| Zugriffsrechte | **Wiki.js** (Gruppen, Page-Rules des Users) | hart, serverseitig |
| Agenten-Schutz | `WIKIJS_OAUTH_ROLE` (Default `wiki`) | `delete`/`manage_*` nur mit `confirm:true` (Dry-Run zuerst) |
| Tag-Sperre | `WIKIJS_BLOCKED_TAGS` (z. B. `kein-ki`) | Seiten mit dem Tag sind für Agenten unsichtbar & unantastbar |

**Bereiche komplett sperren:** sensible Inhalte unter einen Pfad legen und in
Wiki.js eine **pfadbasierte deny-Page-Rule** setzen (greift zuverlässig, auch
für die Suche). Die Tag-Sperre ist die bequeme Redaktions-Ergänzung — sie
schließt Wiki.js' Tag-Rule-Leak (list/single prüfen Tags nicht) auf MCP-Ebene
für: search, get, list, history, version, update, move, convert, restore,
delete (einzeln/batch/tree). **Nicht** tag-gefiltert: tree/links (nur Pfade/
Titel), Kommentar-Tools, `wiki_graphql` (Escape-Hatch; für OAuth-Sessions per
`confirm` gegated). KI-Zugänge sollten nie `manage:system` in Wiki.js haben —
das hebelt dort ALLE Page-Rules aus.

## Endpunkte

| Pfad | Zweck |
|---|---|
| `/mcp` | MCP Streamable HTTP (Bearer `mcp_at_…` oder Legacy-Credentials) |
| `/oauth/authorize` · `/oauth/token` · `/oauth/register` | OAuth-Flow |
| `/.well-known/oauth-*` | Discovery |
| `/me` | Selbstverwaltung: Verbindungen ansehen/widerrufen |
| `/api/health` | Liveness (Docker/K8s) |

## Grenzen

- OAuth braucht eine persistente Platte → nicht auf Vercel (dort: Handle-Modus).
- Der Ein-Klick-SSO setzt **gleiche Domain** für Wiki und MCP voraus (die
  Compose-Appliance routet beides über einen Host); sonst erscheint das
  Login-Formular.
- `/me`-Login per Formular unterstützt kein 2FA (der OAuth-Authorize-Flow
  schon) — 2FA-Nutzer melden sich fürs `/me` einfach im Wiki an (SSO-Pfad).
- Legt keine Wiki-Seiten unter den Pfaden `me`, `oauth`, `mcp`, `sse`, `api`
  an — diese Pfade gehören dem MCP-Server (Reverse-Proxy-Routing).
- Die `confirm`-Gates der Rolle `wiki` gelten für **OAuth-Sessions**. Wer statt
  dessen eine eigene Wiki-Credential direkt per Header mitschickt (Legacy/BYOK),
  unterliegt der Policy seines Profils bzw. dem BYOK-Verhalten — kein
  Sicherheitsverlust, denn wer einen echten Wiki-Key besitzt, kann Wiki.js
  ohnehin direkt ansprechen. Die Tag-Sperre greift für alle Credential-Typen.
- `PUBLIC_BASE_URL` ist hinter einem Reverse-Proxy **Pflicht**: sie ist die
  Referenz für OAuth-Issuer, Redirects und den CSRF-Origin-Check. Ohne sie
  werden `X-Forwarded-*`-Header verwendet — der Proxy muss sie dann setzen und
  von außen kommende Varianten überschreiben.
