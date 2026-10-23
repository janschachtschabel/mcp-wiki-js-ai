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
# optional: MCP_ALLOWED_REDIRECT_HOSTS=<host1>,<host2>   # erlaubte Redirect-Hosts für Clients
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
läuft die Session aus, spätestens aber 30 Tage nach der Freigabe (absolute
Höchstdauer) — der Client startet die Ein-Klick-Freigabe erneut.
**Widerruf:** jederzeit unter `/me` (sofort wirksam); Clients können ihre
Tokens selbst über `/oauth/revoke` widerrufen.

## Technik (Kurzfassung)

- OAuth 2.1 Authorization-Code + PKCE (S256), Public Clients, **Dynamic Client
  Registration** (RFC 7591) — claude.ai/Codex registrieren sich selbst.
- Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) und
  `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728); unauthentifizierte
  `/mcp`-Requests bekommen den spec-konformen `401` + `WWW-Authenticate`
  (mit `scope="wiki"`).
- Token-Widerruf über `/oauth/revoke` (RFC 7009; Access- oder Refresh-Token
  beendet die ganze Session, unbekannte Tokens → trotzdem `200`); `iss` in der
  Autorisierungsantwort (RFC 9207); ein mitgeschicktes `resource` (RFC 8707)
  muss `<issuer>/mcp` sein, sonst `invalid_target`.
- **Redirect-Ziele:** Optional `MCP_ALLOWED_REDIRECT_HOSTS` (kommagetrennte
  Hostnamen): Clients dürfen dann nur diese Hosts als `redirect_uri`
  registrieren; Loopback ist immer erlaubt. Ohne die Variable ist jeder
  https-Host erlaubt (offene DCR). Die Freigabeseite warnt „Nicht verifizierte
  Anwendung" (der Client-Name ist frei gewählt) und zeigt die Ziel-Domain.
- **Session-Store:** sqlite via `node:sqlite` (keine neue Dependency) unter
  `MCP_DATA_DIR`. Tokens werden nur als SHA-256-Hash gespeichert; der Wiki-JWT
  AES-256-GCM-verschlüsselt (Schlüssel via HKDF aus `MCP_SESSION_SECRET`, je
  Zweck ein eigener: DB-JWT, `mcp_me`-Cookie, 2FA-Zwischenschritt — eine
  DB-Kopie ergibt kein gültiges Cookie). Das `mcp_me`-Cookie trägt `iat` und
  läuft serverseitig nach 30 min ab. Über TLS heißt es `__Host-mcp_me` (über
  HTTP weiter `mcp_me`). Der 2FA-Zwischenschritt liegt in einem kurzlebigen
  HttpOnly-Cookie (5 min, an Client und PKCE-Challenge gebunden), nicht mehr
  in der URL.
- **Session-Eigentum** (`/me`, Widerruf) hängt an der Wiki-User-ID; ältere
  Sessions ohne gespeicherte ID fallen bis zu ihrem Ablauf auf die E-Mail zurück.
- **Startprüfung:** `MCP_SESSION_SECRET` kürzer als 16 Zeichen, unbekannte
  Rollennamen (`WIKIJS_OAUTH_ROLE`, `WIKIJS_PERMISSION_PRESET`, Profil-`role`)
  oder kaputtes JSON in `WIKIJS_PROFILES`/`WIKIJS_ROLES`/`WIKIJS_KEY_MAP`/
  `WIKIJS_POLICY` → der Server startet nicht (statt still offen zu laufen).
  Warnungen u. a. bei `PUBLIC_BASE_URL` ohne `MCP_SESSION_SECRET` (OAuth ist
  dann aus) und bei OAuth ohne `PUBLIC_BASE_URL`. Im stdio-Betrieb entfallen
  die OAuth-/HTTP-Prüfungen (Secret-Länge, `PUBLIC_BASE_URL`, OAuth-Rolle).
- **Limits:** Formular-/Token-/Register-Bodies max. 64 KB, `/mcp` max. 4 MB
  (sonst `413`); `redirect_uris` max. 2048 Zeichen; registrierte Clients ohne
  Session werden nach 24 h entfernt.
- **Rate-Limits (pro Prozess, im Speicher):** Formular-Logins (Freigabeseite
  und `/me`) max. 10 **Fehlversuche** pro Client-IP und 5 pro Benutzername je
  15 min; falsche 2FA-Codes zählen für IP und Konto. Erfolgreiche Logins zählen
  nicht (eine Schule/ein Büro hinter einer NAT-Adresse sperrt sich nicht
  selbst) und setzen den Zähler des Kontos zurück; „Wiki nicht erreichbar“ und
  das Wiki.js-eigene Limit zählen ebenfalls nicht. Ist die IP gesperrt, wird
  der Versuch abgewiesen, ohne dem Konto angerechnet zu werden. Laufende
  Sperren werden auch bei vollem Speicher (10 000 Schlüssel) nicht verdrängt.
  Dynamische Client-Registrierung max. 20 pro IP und Stunde (sonst `429` +
  `Retry-After`). Als Client-IP gilt der **rechteste** `X-Forwarded-For`-Eintrag
  (den der eigene Proxy anhängt). **Voraussetzung ist ein vorgeschalteter
  Proxy, der `X-Forwarded-For` setzt bzw. anhängt** (Caddy in der Appliance,
  Ingress in Kubernetes): Next.js füllt den Header nur, wenn er fehlt — wer den
  Server direkt erreicht, kann sich mit einem eigenen Header beliebige IPs
  geben und die IP-Limits umgehen.
  Grund: Wiki.js begrenzt Logins zwar auf 5/min pro `req.ip`, aber alle
  Formular-Logins kommen von der Adresse dieses Servers — das ist **ein
  gemeinsamer Topf für alle Nutzer**, kein Schutz pro Nutzer. Der eigene
  Limiter verhindert, dass ein einzelner Absender ihn leert.
- **Refresh-Rotation mit Reuse-Detection:** jeder Refresh tauscht Access- UND
  Refresh-Token; taucht ein bereits rotiertes Refresh-Token erneut auf
  (Diebstahl-Signal), wird die gesamte Session sofort widerrufen. Ausnahme:
  ein Retry innerhalb von 60 s nach der Rotation (verlorene Antwort, paralleler
  Refresh) wird abgelehnt, widerruft die Session aber nicht. Wird ein
  Autorisierungs-Code ein zweites Mal eingelöst, wird die daraus entstandene
  Session widerrufen (OAuth 2.1).
- **Loopback-Redirects** (`http://localhost:<port>/callback`) matchen
  port-agnostisch (RFC 8252) — nötig für Claude/Codex-CLI-Callbacks.
- **Freigabe nur per Klick:** Browser mit Fetch-Metadata müssen für die
  Decision-Route eine echte, vom Nutzer ausgelöste Navigation melden
  (`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-User: ?1`). Skripte auf derselben Origin (z. B. Seiten-JS im
  Wiki) können so nicht still per `fetch()` zustimmen. Zusätzlich gilt der
  Origin-Check.
- **CSRF-Nonce der Freigabeseite:** Wiki.js lässt in Seiteninhalten ein
  `<form method="post" action="/oauth/authorize/decision">` mit versteckten
  Feldern stehen; der Klick eines Lesers darauf ist eine echte Navigation auf
  derselben Origin und besteht Origin- und Fetch-Metadata-Prüfung. Deshalb
  erzeugt jeder Aufruf von `/oauth/authorize` (im Next.js-`proxy.ts`) eine
  zufällige Nonce: als HttpOnly-Cookie `mcp_csrf` (über TLS `__Host-mcp_csrf`,
  SameSite=Strict, 10 min, verschlüsselt und an `client_id` + PKCE-Challenge
  gebunden) und als verstecktes Formularfeld. Die Decision-Route verlangt
  beides für jeden Modus (Freigabe, Login, 2FA, Ablehnen), sonst `403`. Folge:
  Wird die Freigabeseite in einem zweiten Tab neu geöffnet, ist der ältere Tab
  ungültig. Dasselbe gilt für die `/me`-Formulare (Anmelden, Abmelden,
  Widerrufen): Jeder Aufruf von `/me` setzt eine eigene Nonce (Cookie
  `mcp_csrf_me` bzw. `__Host-mcp_csrf_me`, an den Zweck `me` gebunden, 10 min),
  die drei Routen verlangen sie, sonst `403`. Eigene Cookies je Zweck: Ein
  offener `/me`-Tab entwertet keine Freigabeseite, und keine Nonce gilt für den
  anderen Zweck. Grenze: Ein **Skript** auf derselben Origin kann die Seite laden
  und die Nonce lesen — dagegen hilft nur, dass Wiki.js' HTML-Bereinigung
  (Skripte in Seiten) aktiv bleibt.
- **HTTP-Header** (Next.js): CSP mit `default-src 'self'`, `X-Frame-Options:
  DENY`, `nosniff`, `Referrer-Policy: same-origin`, kein `X-Powered-By`.
  Bewusst nicht `no-referrer`: Browser senden dann `Origin: null`, und der
  CSRF-Check lehnt die eigenen Login-Formulare ab. Nur unter `next dev`
  (`NODE_ENV` ≠ `production`) enthält `script-src` zusätzlich `'unsafe-eval'`,
  das React im Entwicklungsmodus braucht; Build und Produktion bleiben ohne.
- Passwörter werden **nie gespeichert**, nur an Wiki.js' `login`-Mutation
  durchgereicht.
- **Transport-Routing:** Bei aktivem OAuth geht **jeder** Request in den
  OAuth-Flow (401 → Discovery). Der Legacy-Pfad (BYOK-Bearer,
  `X-Wikijs-Token`-Handle, `?token=`) ist daneben nur erreichbar, wenn
  `WIKIJS_ALLOW_LEGACY=true` gesetzt ist — er hat keine eigene Anmeldung und
  würde sonst anonyme Upstream-Aufrufe erlauben. Auch dann zählt nur eine
  *nicht-leere* Legacy-Credential. Ein Single-Tenant-Env-Token (`WIKIJS_TOKEN`)
  wird bei aktivem OAuth **nie** als Fallback verwendet (ebenso nicht, sobald
  `WIKIJS_PROFILES` oder `WIKIJS_KEY_MAP` gesetzt sind).

## Rechte & Guardrails

| Schicht | Quelle | Wirkung |
|---|---|---|
| Zugriffsrechte | **Wiki.js** (Gruppen, Page-Rules des Users) | hart, serverseitig |
| Agenten-Schutz | `WIKIJS_OAUTH_ROLE` (Default `wiki`) | `delete`/`manage_*` nur mit `confirm:true` (Dry-Run zuerst) — Bremse, keine menschliche Freigabe (das Modell setzt `confirm` selbst) |
| Tag-Sperre | `WIKIJS_BLOCKED_TAGS` (z. B. `kein-ki`) | Seiten mit dem Tag sind für Agenten unsichtbar & unantastbar |

Per Request lässt sich die Agenten-Schutzschicht weiter verschärfen:
`X-Wikijs-Preset` und `X-Wikijs-Policy` (bzw. `?preset=`/`?policy=`) wirken
auch für OAuth-Sitzungen, auch beide zusammen — nie lockernd.
`scriptJs`/`scriptCss` beim Anlegen/Ändern von Seiten brauchen den Modus von
`manage_system` (Policy-Schlüssel `wiki_page_scripts`); in der Rolle `wiki`
also `confirm`.

**Bereiche komplett sperren:** sensible Inhalte unter einen Pfad legen und in
Wiki.js eine **pfadbasierte deny-Page-Rule** setzen (greift zuverlässig, auch
für die Suche). Die Tag-Sperre ist die bequeme Redaktions-Ergänzung — sie
schließt Wiki.js' Tag-Rule-Leak (list/single prüfen Tags nicht) auf MCP-Ebene
für: search, get, list, history, version, render, update, move, convert,
restore, delete (einzeln/batch/tree); tree/links blenden gesperrte Seiten aus
(`wiki_pages_tree` liefert dann `{ tree, hiddenByTagGuardrail }`);
`wiki_comments_list` und `wiki_comment_create` werden für gesperrte Seiten
abgelehnt, ebenso `wiki_comment_get`/`_update`/`_delete` für Kommentare
gesperrter Seiten (abgeglichen über deren Kommentarlisten). **Nicht** geprüft:
`wiki_graphql` (Escape-Hatch; in der OAuth-Rolle `wiki` und allen anderen Rollen außer
`systemadmin`/`full` gesperrt). Ablehnungen der Tag-Sperre bei schreibenden
Tools stehen im Audit-Log als `blocked`. KI-Zugänge sollten nie
`manage:system` in Wiki.js haben — das hebelt dort ALLE Page-Rules aus.

## Endpunkte

| Pfad | Zweck |
|---|---|
| `/mcp` | MCP Streamable HTTP (Bearer `mcp_at_…` oder Legacy-Credentials) |
| `/oauth/authorize` · `/oauth/token` · `/oauth/register` | OAuth-Flow |
| `/oauth/revoke` | Token-Widerruf (RFC 7009) |
| `/.well-known/oauth-*` | Discovery |
| `/me` | Selbstverwaltung: Verbindungen ansehen/widerrufen |
| `/api/health` | Liveness (Docker/K8s); mit OAuth `503`, wenn der Session-Store nicht antwortet |

## Grenzen

- OAuth braucht eine persistente Platte → nicht auf Vercel (dort: Handle-Modus).
- Der Ein-Klick-SSO setzt **gleiche Domain** für Wiki und MCP voraus (die
  Compose-Appliance routet beides über einen Host); sonst erscheint das
  Login-Formular.
- `/me`-Login per Formular unterstützt kein 2FA (der OAuth-Authorize-Flow
  schon) — 2FA-Nutzer melden sich fürs `/me` einfach im Wiki an (SSO-Pfad).
- Abmelden auf `/me` löscht nur das Cookie im Browser. Das Cookie ist
  zustandslos: ein kopierter Wert bleibt bis zu 30 min gültig.
- Die Rate-Limits gelten pro Prozess (wie der sqlite-Store, eine Replika).
  Da nur Fehlversuche zählen, kann jemand mit gültigem Wiki-Konto den
  gemeinsamen Login-Topf von Wiki.js (5/min für diesen Server) mit echten
  Logins belegen. Ein fremdes Konto lässt sich mit 5 Fehlversuchen für 15 min
  sperren (Preis jeder Sperre pro Konto).
  Steht vor dem eigenen Proxy ein weiterer (z. B. CDN → Caddy), ist der
  rechteste `X-Forwarded-For`-Eintrag dessen Adresse — dann teilen sich alle
  Nutzer wieder einen IP-Topf.
- Legt keine Wiki-Seiten unter den Pfaden `me`, `oauth`, `mcp`, `api`
  an — diese Pfade gehören dem MCP-Server (Reverse-Proxy-Routing).
- Die `confirm`-Gates der Rolle `wiki` gelten für **OAuth-Sessions**. Wer statt
  dessen (mit `WIKIJS_ALLOW_LEGACY=true`) eine eigene Wiki-Credential direkt per
  Header mitschickt (Legacy/BYOK),
  unterliegt der Policy seines Profils bzw. dem BYOK-Verhalten — kein
  Sicherheitsverlust, denn wer einen echten Wiki-Key besitzt, kann Wiki.js
  ohnehin direkt ansprechen. Die Tag-Sperre greift für alle Credential-Typen.
- `PUBLIC_BASE_URL` ist hinter einem Reverse-Proxy **Pflicht**: sie ist die
  Referenz für OAuth-Issuer, Redirects und den CSRF-Origin-Check. Ohne sie
  werden `X-Forwarded-*`-Header verwendet — der Proxy muss sie dann setzen und
  von außen kommende Varianten überschreiben.
